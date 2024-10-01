const ethers = require("ethers");
const { findOpp } = require("./modes");
const { Token } = require("sushi/currency");
const { rotateAccounts, fundOwnedOrders } = require("./account");
const { createViemClient } = require("./config");
const { arbAbis, orderbookAbi } = require("./abis");
const { SpanStatusCode } = require("@opentelemetry/api");
const { privateKeyToAccount } = require("viem/accounts");
const { ErrorSeverity, errorSnapshot } = require("./error");
const {
    toNumber,
    getIncome,
    getEthPrice,
    quoteOrders,
    bundleOrders,
    PoolBlackList,
    getTotalIncome,
    quoteSingleOrder,
    checkOwnedOrders,
    getActualClearAmount,
    withBigintSerializer,
    getMarketQuote,
} = require("./utils");

/**
 * @import { Tracer } from "@opentelemetry/sdk-trace-base"
 * @import { Context } from "@opentelemetry/api"
 * @import { PublicClient } from "viem"
 * @import { DataFetcher } from "sushi"
 * @import { BotConfig, BundledOrders, ProcessPairResult, ViemClient } from "./types"
 */

/**
 * Specifies reason that order process halted
 * @readonly
 * @enum {number}
 */
const ProcessPairHaltReason = {
    FailedToQuote: 1,
    FailedToGetGasPrice: 2,
    FailedToGetEthPrice: 3,
    FailedToGetPools: 4,
    TxFailed: 5,
    TxMineFailed: 6,
    UnexpectedError: 7,
};

/**
 * Specifies status of an processed order report
 * @readonly
 * @enum {number}
 */
const ProcessPairReportStatus = {
    ZeroOutput: 1,
    NoOpportunity: 2,
    FoundOpportunity: 3,
};

/**
 * Main function that processes all given orders and tries clearing them against onchain liquidity and reports the result
 *
 * @param {BotConfig} config - The configuration object
 * @param {any[]} ordersDetails - The order details queried from subgraph
 * @param {Tracer} tracer
 * @param {Context} ctx
 */
const processOrders = async(
    config,
    ordersDetails,
    tracer,
    ctx,
) => {
    const viemClient = config.viemClient;
    const dataFetcher = config.dataFetcher;
    const accounts = config.accounts;
    const mainAccount = config.mainAccount;

    // instantiating arb contract
    const arb = new ethers.Contract(config.arbAddress, arbAbis);
    let genericArb;
    if (config.genericArbAddress) {
        genericArb = new ethers.Contract(config.genericArbAddress, arbAbis);
    }

    // prepare orders
    const bundledOrders = bundleOrders(
        ordersDetails,
        config.shuffle,
        true,
    );
    // check owned orders' vaults
    const ownedOrders = await checkOwnedOrders(config, bundledOrders);
    if (ownedOrders.length) {
        const failedFundings = await fundOwnedOrders(ownedOrders, config);
        const emptyOrders = ownedOrders.filter(v => v.vaultBalance.isZero());
        if (failedFundings.length || emptyOrders.length) {
            await tracer.startActiveSpan("handle-owned-orders", {}, ctx, async (span) => {
                let severity = ErrorSeverity.MEDIUM;
                const message = [];
                if (emptyOrders.length) {
                    severity = ErrorSeverity.HIGH;
                    message.push(...[
                        "Reason: following owned orders have empty vaults:",
                        ...ownedOrders.map(v => `\nhash: ${v.id},\ntoken: ${v.symbol},\nvault: ${v.vaultId}`)
                    ]);
                }
                if (failedFundings.length) {
                    span.setAttribute("failedFundings", failedFundings.map(v => JSON.stringify({
                        orderId: v.ownedOrder.id,
                        orderbook: v.ownedOrder.orderbook,
                        token: v.ownedOrder.token,
                        symbol: v.ownedOrder.symbol,
                        error: v.error
                    })));
                }
                span.setAttribute("severity", severity);
                span.setStatus({ code: SpanStatusCode.ERROR, message });
                span.end();
            });
        }
    }
    await quoteOrders(
        bundledOrders,
        config.isTest ? config.quoteRpc : config.rpc
    );

    let avgGasCost;
    const reports = [];
    for (const orderbookOrders of bundledOrders) {
        for (const pairOrders of orderbookOrders) {
            // instantiating orderbook contract
            const orderbook = new ethers.Contract(pairOrders.orderbook, orderbookAbi);

            for (let i = 0; i < pairOrders.takeOrders.length; i++) {
                const orderPairObject = {
                    orderbook: pairOrders.orderbook,
                    buyToken: pairOrders.buyToken,
                    buyTokenSymbol: pairOrders.buyTokenSymbol,
                    buyTokenDecimals: pairOrders.buyTokenDecimals,
                    sellToken: pairOrders.sellToken,
                    sellTokenSymbol: pairOrders.sellTokenSymbol,
                    sellTokenDecimals: pairOrders.sellTokenDecimals,
                    takeOrders: [pairOrders.takeOrders[i]]
                };
                const signer = accounts.length ? accounts[0] : mainAccount;
                const flashbotSigner = config.flashbotRpc
                    ? await createViemClient(
                        config.chain.id,
                        [config.flashbotRpc],
                        undefined,
                        privateKeyToAccount(ethers.utils.hexlify(
                            ethers.utils.hexlify(signer.account.getHdKey().privateKey)
                        )),
                        config.timeout
                    )
                    : undefined;

                const pair = `${pairOrders.buyTokenSymbol}/${pairOrders.sellTokenSymbol}`;

                // instantiate a span for this pair
                const span = tracer.startSpan(`order_${pair}`, undefined, ctx);

                // process the pair
                try {
                    const result = await processPair({
                        config,
                        orderPairObject,
                        viemClient,
                        dataFetcher,
                        signer,
                        flashbotSigner,
                        arb,
                        genericArb,
                        orderbook,
                        pair,
                        mainAccount,
                        accounts,
                        orderbooksOrders: bundledOrders
                    });

                    // keep track of avggas cost
                    if (result.gasCost) {
                        if (!avgGasCost) {
                            avgGasCost = result.gasCost;
                        } else {
                            avgGasCost = avgGasCost.add(result.gasCost).div(2);
                        }
                    }

                    reports.push(result.report);

                    // set the span attributes with the values gathered at processPair()
                    span.setAttributes(result.spanAttributes);

                    // set the otel span status based on report status
                    if (result.report.status === ProcessPairReportStatus.ZeroOutput) {
                        span.setStatus({ code: SpanStatusCode.OK, message: "zero max output" });
                    } else if (result.report.status === ProcessPairReportStatus.NoOpportunity) {
                        span.setStatus({ code: SpanStatusCode.OK, message: "no opportunity" });
                    } else if (result.report.status === ProcessPairReportStatus.FoundOpportunity) {
                        span.setStatus({ code: SpanStatusCode.OK, message: "found opportunity" });
                    } else {
                        // set the span status to unexpected error
                        span.setAttribute("severity", ErrorSeverity.HIGH);
                        span.setStatus({ code: SpanStatusCode.ERROR, message: "unexpected error" });
                    }
                } catch(e) {

                    // keep track of avg gas cost
                    if (e.gasCost) {
                        if (!avgGasCost) {
                            avgGasCost = e.gasCost;
                        } else {
                            avgGasCost = avgGasCost.add(e.gasCost).div(2);
                        }
                    }

                    // set the span attributes with the values gathered at processPair()
                    span.setAttributes(e.spanAttributes);

                    // record otel span status based on reported reason
                    if (e.reason) {
                        // report the error reason along with the rest of report
                        reports.push({
                            ...e.report,
                            error: e.error,
                            reason: e.reason,
                        });
                        span.setAttribute("severity", ErrorSeverity.MEDIUM);

                        // set the otel span status based on returned reason
                        if (e.reason === ProcessPairHaltReason.FailedToQuote) {
                            let message = "failed to quote order: " + orderPairObject.takeOrders[0].id;
                            if (e.error) {
                                message = errorSnapshot(message, e.error);
                            }
                            span.setStatus({ code: SpanStatusCode.OK, message });
                        } else if (e.reason === ProcessPairHaltReason.FailedToGetGasPrice) {
                            let message = pair + ": failed to get gas price";
                            if (e.error) {
                                message = errorSnapshot(message, e.error);
                                span.recordException(e.error);
                            }
                            span.setAttribute("severity", ErrorSeverity.MEDIUM);
                            span.setStatus({ code: SpanStatusCode.ERROR, message });
                        } else if (e.reason === ProcessPairHaltReason.FailedToGetPools) {
                            let message = pair + ": failed to get pool details";
                            if (e.error) {
                                message = errorSnapshot(message, e.error);
                                span.recordException(e.error);
                            }
                            span.setAttribute("severity", ErrorSeverity.MEDIUM);
                            span.setStatus({ code: SpanStatusCode.ERROR, message });
                        } else if (e.reason === ProcessPairHaltReason.FailedToGetEthPrice) {
                            // set OK status because a token might not have a pool and as a result eth price cannot
                            // be fetched for it and if it is set to ERROR it will constantly error on each round
                            // resulting in lots of false positives
                            let message = "failed to get eth price";
                            if (e.error) {
                                message = errorSnapshot(message, e.error);
                                span.setAttribute("errorDetails", message);
                            }
                            span.setStatus({ code: SpanStatusCode.OK, message });
                        } else {
                            // set the otel span status as OK as an unsuccessfull clear, this can happen for example
                            // because of mev front running or false positive opportunities, etc
                            let message = "transaction failed";
                            if (e.error) {
                                message = errorSnapshot(message, e.error);
                                span.setAttribute("errorDetails", message);
                            }
                            span.setStatus({ code: SpanStatusCode.OK, message });
                            span.setAttribute("unsuccessfullClear", true);
                        }
                    } else {
                        // record the error for the span
                        let message = pair + ": unexpected error";
                        if (e.error) {
                            message = errorSnapshot(message, e.error);
                            span.recordException(e.error);
                        }

                        // report the unexpected error reason
                        reports.push({
                            ...e.report,
                            error: e.error,
                            reason: ProcessPairHaltReason.UnexpectedError,
                        });
                        // set the span status to unexpected error
                        span.setAttribute("severity", ErrorSeverity.HIGH);
                        span.setStatus({ code: SpanStatusCode.ERROR, message });
                    }
                }
                span.end();

                // rotate the accounts once they are used once
                rotateAccounts(accounts);
            }
        }
    }
    return { reports, avgGasCost };
};

/**
 * Processes an pair order by trying to clear it against an onchain liquidity and reporting the result
 * @param {{
 *  config: BotConfig,
 *  orderPairObject: BundledOrders,
 *  viemClient: PublicClient,
 *  dataFetcher: DataFetcher,
 *  signer: ViemClient,
 *  flashbotSigner: ViemClient|undefined,
 *  arb: ethers.Contract,
 *  genericArb: ethers.Contract,
 *  orderbook: ethers.Contract,
 *  pair: string,
 *  orderbooksOrders: BundledOrders[][]
 * }} args
 * @returns {Promise<ProcessPairResult>}
 */
async function processPair(args) {
    const {
        config,
        orderPairObject,
        viemClient,
        dataFetcher,
        signer,
        flashbotSigner,
        arb,
        genericArb,
        orderbook,
        pair,
        orderbooksOrders,
    } = args;

    const spanAttributes = {};
    const result = {
        reason: undefined,
        error: undefined,
        report: undefined,
        gasCost: undefined,
        spanAttributes,
    };

    spanAttributes["details.orders"] = orderPairObject.takeOrders.map(v => v.id);
    spanAttributes["details.pair"] = pair;

    const fromToken = new Token({
        chainId: config.chain.id,
        decimals: orderPairObject.sellTokenDecimals,
        address: orderPairObject.sellToken,
        symbol: orderPairObject.sellTokenSymbol
    });
    const toToken = new Token({
        chainId: config.chain.id,
        decimals: orderPairObject.buyTokenDecimals,
        address: orderPairObject.buyToken,
        symbol: orderPairObject.buyTokenSymbol
    });

    try {
        await quoteSingleOrder(
            orderPairObject,
            config.isTest ? config.quoteRpc : config.rpc
        );
        if (orderPairObject.takeOrders[0].quote.maxOutput.isZero()) {
            result.report = {
                status: ProcessPairReportStatus.ZeroOutput,
                tokenPair: pair,
                buyToken: orderPairObject.buyToken,
                sellToken: orderPairObject.sellToken,
            };
            return result;
        }
    } catch(e) {
        result.error = e;
        result.reason = ProcessPairHaltReason.FailedToQuote;
        throw result;
    }

    spanAttributes["details.quote"] = JSON.stringify({
        maxOutput: ethers.utils.formatUnits(orderPairObject.takeOrders[0].quote.maxOutput),
        ratio: ethers.utils.formatUnits(orderPairObject.takeOrders[0].quote.ratio),
    });

    // get gas price
    let gasPrice;
    try {
        const gasPriceBigInt = await viemClient.getGasPrice();
        gasPrice = ethers.BigNumber.from(gasPriceBigInt);
        spanAttributes["details.gasPrice"] = gasPrice.toString();
    } catch(e) {
        result.reason = ProcessPairHaltReason.FailedToGetGasPrice;
        result.error = e;
        throw result;
    }

    // get pool details
    if (!dataFetcher.fetchedPairPools.includes(pair)) {
        console.log("c");
        try {
            const options = {
                fetchPoolsTimeout: 90000,
            };
            // pin block number for test case
            if (config.isTest && config.testBlockNumber) {
                options.blockNumber = config.testBlockNumber;
            }
            await dataFetcher.fetchPoolsForToken(
                fromToken,
                toToken,
                PoolBlackList,
                options
            );
            const p1 = `${orderPairObject.buyTokenSymbol}/${orderPairObject.sellTokenSymbol}`;
            const p2 = `${orderPairObject.sellTokenSymbol}/${orderPairObject.buyTokenSymbol}`;
            if (!dataFetcher.fetchedPairPools.includes(p1)) dataFetcher.fetchedPairPools.push(p1);
            if (!dataFetcher.fetchedPairPools.includes(p2)) dataFetcher.fetchedPairPools.push(p2);
        } catch(e) {
            result.reason = ProcessPairHaltReason.FailedToGetPools;
            result.error = e;
            throw result;
        }
    }

    try {
        const marketQuote = getMarketQuote(config, fromToken, toToken, gasPrice);
        if (marketQuote) {
            spanAttributes["details.marketPrice"] = marketQuote.price;
            spanAttributes["details.amountOut"] = marketQuote.amountOut;
        }
    } catch(e) { /**/ }

    // get in/out tokens to eth price
    let inputToEthPrice, outputToEthPrice;
    try {
        const options = {
            fetchPoolsTimeout: 30000,
        };
        // pin block number for test case
        if (config.isTest && config.testBlockNumber) {
            options.blockNumber = config.testBlockNumber;
        }
        inputToEthPrice = await getEthPrice(
            config,
            orderPairObject.buyToken,
            orderPairObject.buyTokenDecimals,
            gasPrice,
            dataFetcher,
            options,
            false,
        );
        outputToEthPrice = await getEthPrice(
            config,
            orderPairObject.sellToken,
            orderPairObject.sellTokenDecimals,
            gasPrice,
            dataFetcher,
            options,
            false,
        );
        if (!inputToEthPrice || !outputToEthPrice) {
            if (config.gasCoveragePercentage === "0") {
                inputToEthPrice = "0";
                outputToEthPrice = "0";
            } else {
                result.reason = ProcessPairHaltReason.FailedToGetEthPrice;
                return Promise.reject(result);
            }
        }
        else {
            const p1 = `${orderPairObject.buyTokenSymbol}/${config.nativeWrappedToken.symbol}`;
            const p2 = `${orderPairObject.sellTokenSymbol}/${config.nativeWrappedToken.symbol}`;
            if (!dataFetcher.fetchedPairPools.includes(p1)) dataFetcher.fetchedPairPools.push(p1);
            if (!dataFetcher.fetchedPairPools.includes(p2)) dataFetcher.fetchedPairPools.push(p2);
            spanAttributes["details.inputToEthPrice"] = inputToEthPrice;
            spanAttributes["details.outputToEthPrice"] = outputToEthPrice;
        }
    } catch(e) {
        if (config.gasCoveragePercentage === "0") {
            inputToEthPrice = "0";
            outputToEthPrice = "0";
        } else {
            result.reason = ProcessPairHaltReason.FailedToGetEthPrice;
            result.error = e;
            throw result;
        }
    }

    // execute process to find opp through different modes
    let rawtx, oppBlockNumber, estimatedProfit;
    try {
        const findOppResult = await findOpp({
            orderPairObject,
            dataFetcher,
            arb,
            genericArb,
            fromToken,
            toToken,
            signer,
            gasPrice: gasPrice.toBigInt(),
            config,
            viemClient,
            inputToEthPrice,
            outputToEthPrice,
            orderbooksOrders,
        });
        ({ rawtx, oppBlockNumber, estimatedProfit } = findOppResult.value);

        // record span attrs
        spanAttributes["details.estimatedProfit"] = ethers.utils.formatUnits(estimatedProfit);
        for (attrKey in findOppResult.spanAttributes) {
            if (attrKey !== "oppBlockNumber" && attrKey !== "foundOpp") {
                spanAttributes["details." + attrKey] = findOppResult.spanAttributes[attrKey];
            }
            else {
                spanAttributes[attrKey] = findOppResult.spanAttributes[attrKey];
            }
        }
    } catch (e) {
        // record all span attributes
        for (attrKey in e.spanAttributes) {
            spanAttributes["details." + attrKey] = e.spanAttributes[attrKey];
        }
        result.report = {
            status: ProcessPairReportStatus.NoOpportunity,
            tokenPair: pair,
            buyToken: orderPairObject.buyToken,
            sellToken: orderPairObject.sellToken,
        };
        return result;
    }

    // from here on we know an opp is found, so record it in report and in otel span attributes
    result.report = {
        status: ProcessPairReportStatus.FoundOpportunity,
        tokenPair: pair,
        buyToken: orderPairObject.buyToken,
        sellToken: orderPairObject.sellToken,
    };
    spanAttributes["foundOpp"] = true;

    // get block number
    let blockNumber;
    try {
        blockNumber = Number(await viemClient.getBlockNumber());
        spanAttributes["details.blockNumber"] = blockNumber;
        spanAttributes["details.blockNumberDiff"] = blockNumber - oppBlockNumber;
    } catch(e) {
        // dont reject if getting block number fails but just record it,
        // since an opp is found and can ultimately be cleared
        spanAttributes["details.blockNumberError"] = errorSnapshot("failed to get block number", e);
    }

    // submit the tx
    let txhash, txUrl;
    try {
        txhash = flashbotSigner !== undefined
            ? await flashbotSigner.sendTransaction(rawtx)
            : await signer.sendTransaction(rawtx);

        txUrl = config.chain.blockExplorers.default.url + "/tx/" + txhash;
        // eslint-disable-next-line no-console
        console.log("\x1b[33m%s\x1b[0m", txUrl, "\n");
        spanAttributes["details.txUrl"] = txUrl;
    } catch(e) {
        // record rawtx in case it is not already present in the error
        spanAttributes["details.rawTx"] = JSON.stringify({
            ...rawtx,
            from: signer.account.address
        }, withBigintSerializer);
        result.error = e;
        result.reason = ProcessPairHaltReason.TxFailed;
        throw result;
    }

    // wait for tx receipt
    try {
        const receipt = await viemClient.waitForTransactionReceipt({
            hash: txhash,
            confirmation: 1
        });

        const actualGasCost = ethers.BigNumber
            .from(receipt.effectiveGasPrice)
            .mul(receipt.gasUsed);
        signer.BALANCE = signer.BALANCE.sub(actualGasCost);
        if (receipt.status === "success") {
            spanAttributes["didClear"] = true;

            const clearActualAmount = getActualClearAmount(
                rawtx.to,
                orderbook.address,
                receipt
            );

            const inputTokenIncome = getIncome(
                signer.account.address,
                receipt,
                orderPairObject.buyToken
            );
            const outputTokenIncome = getIncome(
                signer.account.address,
                receipt,
                orderPairObject.sellToken
            );
            const income = getTotalIncome(
                inputTokenIncome,
                outputTokenIncome,
                inputToEthPrice,
                outputToEthPrice,
                orderPairObject.buyTokenDecimals,
                orderPairObject.sellTokenDecimals
            );
            const netProfit = income
                ? income.sub(actualGasCost)
                : undefined;

            if (income) {
                spanAttributes["details.income"] = toNumber(income);
                spanAttributes["details.netProfit"] = toNumber(netProfit);
                spanAttributes["details.actualGasCost"] = toNumber(actualGasCost);
            }
            if (inputTokenIncome) {
                spanAttributes["details.inputTokenIncome"] = ethers.utils.formatUnits(
                    inputTokenIncome,
                    orderPairObject.buyTokenDecimals
                );
            }
            if (outputTokenIncome) {
                spanAttributes["details.outputTokenIncome"] = ethers.utils.formatUnits(
                    outputTokenIncome,
                    orderPairObject.sellTokenDecimals
                );
            }

            result.report = {
                status: ProcessPairReportStatus.FoundOpportunity,
                txUrl,
                tokenPair: pair,
                buyToken: orderPairObject.buyToken,
                sellToken: orderPairObject.sellToken,
                clearedAmount: clearActualAmount?.toString(),
                actualGasCost: ethers.utils.formatUnits(actualGasCost),
                income,
                inputTokenIncome: inputTokenIncome
                    ? ethers.utils.formatUnits(inputTokenIncome, toToken.decimals)
                    : undefined,
                outputTokenIncome: outputTokenIncome
                    ? ethers.utils.formatUnits(outputTokenIncome, fromToken.decimals)
                    : undefined,
                netProfit,
                clearedOrders: orderPairObject.takeOrders.map(
                    v => v.id
                ),
            };

            // keep track of gas consumption of the account and bounty token
            result.gasCost = actualGasCost;
            if (
                inputTokenIncome &&
                inputTokenIncome.gt(0) &&
                !signer.BOUNTY.find(v => v.address === orderPairObject.buyToken)
            ) {
                signer.BOUNTY.push({
                    address: orderPairObject.buyToken,
                    decimals: orderPairObject.buyTokenDecimals,
                    symbol: orderPairObject.buyTokenSymbol,
                });
            }
            if (
                outputTokenIncome &&
                outputTokenIncome.gt(0) &&
                !signer.BOUNTY.find(v => v.address === orderPairObject.sellToken)
            ) {
                signer.BOUNTY.push({
                    address: orderPairObject.sellToken,
                    decimals: orderPairObject.sellTokenDecimals,
                    symbol: orderPairObject.sellTokenSymbol,
                });
            }
            return result;
        } else {
            // keep track of gas consumption of the account
            result.report = {
                status: ProcessPairReportStatus.FoundOpportunity,
                txUrl,
                tokenPair: pair,
                buyToken: orderPairObject.buyToken,
                sellToken: orderPairObject.sellToken,
                actualGasCost: ethers.utils.formatUnits(actualGasCost),
            };
            result.reason = ProcessPairHaltReason.TxMineFailed;
            return Promise.reject(result);
        }
    } catch(e) {
        // keep track of gas consumption of the account
        let actualGasCost;
        try {
            actualGasCost = ethers.BigNumber.from(e.receipt.effectiveGasPrice)
                .mul(e.receipt.gasUsed);
            signer.BALANCE = signer.BALANCE.sub(actualGasCost);
        } catch {
            /**/
        }
        result.report = {
            status: ProcessPairReportStatus.FoundOpportunity,
            txUrl,
            tokenPair: pair,
            buyToken: orderPairObject.buyToken,
            sellToken: orderPairObject.sellToken,
        };
        if (actualGasCost) {
            result.report.actualGasCost = ethers.utils.formatUnits(actualGasCost);
        }
        result.error = e;
        result.reason = ProcessPairHaltReason.TxMineFailed;
        throw result;
    }
}

module.exports = {
    processOrders,
    processPair,
    ProcessPairHaltReason,
    ProcessPairReportStatus,
};
