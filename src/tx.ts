import { Token } from "sushi/currency";
import { Contract, ethers } from "ethers";
// import { getL1Fee, getTxFee } from "./gas";
import { addWatchedToken } from "./account";
import { containsNodeError, handleRevert } from "./error";
import { ProcessPairHaltReason, ProcessPairReportStatus } from "./processOrders";
import { BotConfig, BundledOrders, ProcessPairResult, RawTx, ViemClient } from "./types";
import { Account, BaseError, Chain, SendTransactionParameters, TransactionReceipt } from "viem";
import {
    sleep,
    toNumber,
    getIncome,
    shuffleArray,
    getTotalIncome,
    withBigintSerializer,
    getActualClearAmount,
} from "./utils";
import { ChainId } from "sushi";
import { BigNumber } from "ethers";
import { getQuoteConfig } from "./utils";
import { publicActionsL2 } from "viem/op-stack";
import { encodeFunctionData, multicall3Abi, toHex } from "viem";
import { OperationState } from "./types";
import { ArbitrumNodeInterfaceAbi, ArbitrumNodeInterfaceAddress, OrderbookQuoteAbi } from "./abis";

/**
 * Handles the given transaction, starts by sending the transaction and
 * then tries to get the receipt and process that in async manner, returns
 * a function that resolves with the ProcessOrderResult type when called
 */
export async function handleTransaction(
    signer: ViemClient,
    viemClient: ViemClient,
    spanAttributes: any,
    rawtx: RawTx,
    orderbook: Contract,
    orderPairObject: BundledOrders,
    inputToEthPrice: string,
    outputToEthPrice: string,
    result: ProcessPairResult,
    pair: string,
    toToken: Token,
    fromToken: Token,
    config: BotConfig,
    writeSigner?: ViemClient,
): Promise<() => Promise<ProcessPairResult>> {
    // submit the tx
    let txhash: `0x${string}`, txUrl: string;
    let time = 0;
    const sendTx = async () => {
        rawtx.gas = getTxGas(config, rawtx.gas!);
        txhash =
            writeSigner !== undefined
                ? await writeSigner.sendTx({
                      ...rawtx,
                      type: "legacy",
                  })
                : await signer.sendTx({
                      ...rawtx,
                      type: "legacy",
                  });
        txUrl = config.chain.blockExplorers?.default.url + "/tx/" + txhash;
        time = Date.now();
        // eslint-disable-next-line no-console
        console.log("\x1b[33m%s\x1b[0m", txUrl, "\n");
        spanAttributes["details.txUrl"] = txUrl;
    };
    try {
        await sendTx();
    } catch (e) {
        try {
            // retry again after 5 seconds if first attempt failed
            await sleep(5000);
            await sendTx();
        } catch {
            // record rawtx in logs
            spanAttributes["details.rawTx"] = JSON.stringify(
                {
                    ...rawtx,
                    from: signer.account.address,
                },
                withBigintSerializer,
            );
            spanAttributes["txNoneNodeError"] = !containsNodeError(e as BaseError);
            result.error = e;
            result.reason = ProcessPairHaltReason.TxFailed;
            return async () => {
                throw result;
            };
        }
    }

    // start getting tx receipt in background and return the settler fn
    const receiptPromise = (async () => {
        try {
            return await viemClient.waitForTransactionReceipt({
                hash: txhash!,
                confirmations: 1,
                timeout: 120_000,
            });
        } catch {
            // in case waiting for tx receipt was unsuccessful, try getting the receipt directly
            try {
                return await viemClient.getTransactionReceipt({ hash: txhash! });
            } catch {
                await sleep(Math.max(90_000 + time - Date.now(), 0));
                return await viemClient.getTransactionReceipt({ hash: txhash! });
            }
        }
    })();
    return async () => {
        try {
            const receipt = await receiptPromise;
            return handleReceipt(
                txhash,
                receipt,
                signer,
                spanAttributes,
                rawtx,
                orderbook,
                orderPairObject,
                inputToEthPrice,
                outputToEthPrice,
                result,
                txUrl,
                pair,
                toToken,
                fromToken,
                config,
                time,
            );
        } catch (e: any) {
            result.report = {
                status: ProcessPairReportStatus.FoundOpportunity,
                txUrl,
                tokenPair: pair,
                buyToken: orderPairObject.buyToken,
                sellToken: orderPairObject.sellToken,
            };
            result.error = e;
            spanAttributes["details.rawTx"] = JSON.stringify(
                {
                    ...rawtx,
                    from: signer.account.address,
                },
                withBigintSerializer,
            );
            spanAttributes["txNoneNodeError"] = !containsNodeError(e);
            result.reason = ProcessPairHaltReason.TxMineFailed;
            throw result;
        }
    };
}

/**
 * Handles the tx receipt
 */
export async function handleReceipt(
    txhash: string,
    receipt: TransactionReceipt,
    signer: ViemClient,
    spanAttributes: any,
    rawtx: RawTx,
    orderbook: Contract,
    orderPairObject: BundledOrders,
    inputToEthPrice: string,
    outputToEthPrice: string,
    result: ProcessPairResult,
    txUrl: string,
    pair: string,
    toToken: Token,
    fromToken: Token,
    config: BotConfig,
    time: number,
): Promise<ProcessPairResult> {
    const l1Fee = getL1Fee(receipt, config);
    const actualGasCost = ethers.BigNumber.from(getTxFee(receipt, config));
    const signerBalance = signer.BALANCE;
    signer.BALANCE = signer.BALANCE.sub(actualGasCost);

    if (receipt.status === "success") {
        spanAttributes["didClear"] = true;

        const clearActualAmount = getActualClearAmount(rawtx.to, orderbook.address, receipt);
        const inputTokenIncome = getIncome(
            signer.account.address,
            receipt,
            orderPairObject.buyToken,
        );
        const outputTokenIncome = getIncome(
            signer.account.address,
            receipt,
            orderPairObject.sellToken,
        );
        const income = getTotalIncome(
            inputTokenIncome,
            outputTokenIncome,
            inputToEthPrice,
            outputToEthPrice,
            orderPairObject.buyTokenDecimals,
            orderPairObject.sellTokenDecimals,
        );
        const netProfit = income ? income.sub(actualGasCost) : undefined;

        spanAttributes["details.actualGasCost"] = toNumber(actualGasCost);
        if (config.isSpecialL2 && l1Fee) {
            spanAttributes["details.gasCostL1"] = toNumber(l1Fee);
        }
        if (income) {
            spanAttributes["details.income"] = toNumber(income);
            spanAttributes["details.netProfit"] = toNumber(netProfit!);
        }
        if (inputTokenIncome) {
            spanAttributes["details.inputTokenIncome"] = ethers.utils.formatUnits(
                inputTokenIncome,
                orderPairObject.buyTokenDecimals,
            );
        }
        if (outputTokenIncome) {
            spanAttributes["details.outputTokenIncome"] = ethers.utils.formatUnits(
                outputTokenIncome,
                orderPairObject.sellTokenDecimals,
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
            clearedOrders: orderPairObject.takeOrders.map((v) => v.id),
        };

        // keep track of gas consumption of the account and bounty token
        result.gasCost = actualGasCost;
        if (inputTokenIncome && inputTokenIncome.gt(0)) {
            const tkn = {
                address: orderPairObject.buyToken.toLowerCase(),
                decimals: orderPairObject.buyTokenDecimals,
                symbol: orderPairObject.buyTokenSymbol,
            };
            addWatchedToken(tkn, config.watchedTokens ?? [], signer);
        }
        if (outputTokenIncome && outputTokenIncome.gt(0)) {
            const tkn = {
                address: orderPairObject.sellToken.toLowerCase(),
                decimals: orderPairObject.sellTokenDecimals,
                symbol: orderPairObject.sellTokenSymbol,
            };
            addWatchedToken(tkn, config.watchedTokens ?? [], signer);
        }
        return result;
    } else {
        const simulation = await (async () => {
            const result = await handleRevert(
                signer,
                txhash as `0x${string}`,
                receipt,
                rawtx,
                signerBalance,
                orderbook.address as `0x${string}`,
            );
            if (result.snapshot.includes("simulation failed to find the revert reason")) {
                // wait at least 90s before simulating the revert tx
                // in order for rpcs to catch up, this is concurrent to
                // whole bot operation, so ideally all of it or at least
                // partially will overlap with when bot is processing other
                // orders
                await sleep(Math.max(90_000 + time - Date.now(), 0));
                return await handleRevert(
                    signer,
                    txhash as `0x${string}`,
                    receipt,
                    rawtx,
                    signerBalance,
                    orderbook.address as `0x${string}`,
                );
            } else {
                return result;
            }
        })();
        if (simulation) {
            result.error = simulation;
            spanAttributes["txNoneNodeError"] = !simulation.nodeError;
        }
        result.report = {
            status: ProcessPairReportStatus.FoundOpportunity,
            txUrl,
            tokenPair: pair,
            buyToken: orderPairObject.buyToken,
            sellToken: orderPairObject.sellToken,
            actualGasCost: ethers.utils.formatUnits(actualGasCost),
        };
        result.reason = ProcessPairHaltReason.TxReverted;
        return Promise.reject(result);
    }
}

/**
 * A wrapper for sending transactions that handles nonce and keeps
 * signer busy while the transaction is being sent
 */
export async function sendTransaction<chain extends Chain, account extends Account>(
    signer: ViemClient,
    tx: SendTransactionParameters<chain, account>,
): Promise<`0x${string}`> {
    // make sure signer is free
    await pollSigners([signer]);

    // start sending tranaction process
    signer.BUSY = true;
    try {
        const nonce = await getNonce(signer);
        const result = await signer.sendTransaction({ ...(tx as any), nonce });
        signer.BUSY = false;
        return result;
    } catch (error) {
        signer.BUSY = false;
        throw error;
    }
}

/**
 * A wrapper fn to get an signer's nonce at latest mined block
 */
export async function getNonce(client: ViemClient): Promise<number> {
    if (!client?.account?.address) throw "undefined account";
    return await client.getTransactionCount({
        address: client.account.address,
        blockTag: "latest",
    });
}

/**
 * Returns the first available signer by polling the
 * signers until first one becomes available
 */
export async function getSigner(
    accounts: ViemClient[],
    mainAccount: ViemClient,
    shuffle = false,
): Promise<ViemClient> {
    if (shuffle && accounts.length) {
        shuffleArray(accounts);
    }
    const accs = accounts.length ? accounts : [mainAccount];
    return await pollSigners(accs);
}

/**
 * Polls an array of given signers in 30ms intervals
 * until the first one becomes free for consumption
 */
export async function pollSigners(accounts: ViemClient[]): Promise<ViemClient> {
    for (;;) {
        const acc = accounts.find((v) => !v.BUSY);
        if (acc) {
            return acc;
        } else {
            await sleep(30);
        }
    }
}

/**
 * Returns the gas limit for a tx by applying the specified config
 */
export function getTxGas(config: BotConfig, gas: bigint): bigint {
    if (config.txGas) {
        if (config.txGas.endsWith("%")) {
            const multiplier = BigInt(config.txGas.substring(0, config.txGas.length - 1));
            return (gas * multiplier) / 100n;
        } else {
            return BigInt(config.txGas);
        }
    } else {
        return gas;
    }
}

// default gas price for bsc chain, 1 gwei
export const BSC_DEFAULT_GAS_PRICE = 1_000_000_000n as const;

/**
 * Estimates gas cost of the given tx, also takes into account L1 gas cost if the chain is a special L2.
 */
export async function estimateGasCost(
    tx: RawTx,
    signer: ViemClient,
    config: BotConfig,
    l1GasPrice?: bigint,
    l1Signer?: any,
) {
    const gasPrice =
        tx.gasPrice ?? ((await signer.getGasPrice()) * BigInt(config.gasPriceMultiplier)) / 100n;
    const gas = await signer.estimateGas(tx);
    const result = {
        gas,
        gasPrice,
        l1GasPrice: 0n,
        l1Cost: 0n,
        totalGasCost: gasPrice * gas,
    };
    if (config.isSpecialL2) {
        try {
            const l1Signer_ = l1Signer ? l1Signer : signer.extend(publicActionsL2());
            if (typeof l1GasPrice !== "bigint") {
                l1GasPrice = (await l1Signer_.getL1BaseFee()) as bigint;
            }
            const l1Cost = await l1Signer_.estimateL1Fee({
                to: tx.to,
                data: tx.data,
            });
            result.l1GasPrice = l1GasPrice;
            result.l1Cost = l1Cost;
            result.totalGasCost += l1Cost;
        } catch {}
    }
    return result;
}

/**
 * Retruns the L1 gas cost of a transaction if operating chain is special L2 else returns 0.
 */
export function getL1Fee(receipt: any, config: BotConfig): bigint {
    if (!config.isSpecialL2) return 0n;

    if (typeof receipt.l1Fee === "bigint") {
        return receipt.l1Fee;
    } else if (typeof receipt.l1GasPrice === "bigint" && typeof receipt.l1GasUsed === "bigint") {
        return (receipt.l1GasPrice as bigint) * (receipt.l1GasUsed as bigint);
    } else {
        return 0n;
    }
}

/**
 * Get Transaction total gas cost from receipt (includes L1 fee)
 */
export function getTxFee(receipt: any, config: BotConfig): bigint {
    const gasUsed = BigNumber.from(receipt.gasUsed).toBigInt();
    const effectiveGasPrice = BigNumber.from(receipt.effectiveGasPrice).toBigInt();
    return effectiveGasPrice * gasUsed + getL1Fee(receipt, config);
}

/**
 * Fetches the gas price (L1 gas price as well if chain is special L2)
 */
export async function getGasPrice(config: BotConfig, state: OperationState) {
    const promises = [config.viemClient.getGasPrice()];
    if (config.isSpecialL2) {
        const l1Client = config.viemClient.extend(publicActionsL2());
        promises.push(l1Client.getL1BaseFee());
    }
    const [gasPriceResult, l1GasPriceResult = undefined] = await Promise.allSettled(promises);
    if (gasPriceResult.status === "fulfilled") {
        let gasPrice = gasPriceResult.value;
        if (config.chain.id === ChainId.BSC && gasPrice < BSC_DEFAULT_GAS_PRICE) {
            gasPrice = BSC_DEFAULT_GAS_PRICE;
        }
        state.gasPrice = (gasPrice * BigInt(config.gasPriceMultiplier)) / 100n;
    }
    if (l1GasPriceResult?.status === "fulfilled") {
        state.l1GasPrice = l1GasPriceResult.value;
    }
}

/**
 * Calculates the gas limit that used for quoting orders
 */
export async function getQuoteGas(
    config: BotConfig,
    orderDetails: BundledOrders,
    multicallAddressOverride?: string,
): Promise<bigint> {
    if (config.chain.id === ChainId.ARBITRUM) {
        // build the calldata of a quote call
        const quoteConfig = getQuoteConfig(orderDetails.takeOrders[0]) as any;
        quoteConfig.inputIOIndex = BigInt(quoteConfig.inputIOIndex);
        quoteConfig.outputIOIndex = BigInt(quoteConfig.outputIOIndex);
        quoteConfig.order.evaluable.bytecode = toHex(quoteConfig.order.evaluable.bytecode);
        const multicallConfig = {
            target: orderDetails.orderbook as `0x${string}`,
            allowFailure: true,
            callData: encodeFunctionData({
                abi: OrderbookQuoteAbi,
                functionName: "quote",
                args: [quoteConfig],
            }),
        };
        const calldata = encodeFunctionData({
            abi: multicall3Abi,
            functionName: "aggregate3",
            args: [[multicallConfig] as const],
        });

        const multicallAddress =
            (multicallAddressOverride as `0x${string}` | undefined) ??
            config.viemClient.chain?.contracts?.multicall3?.address;
        if (!multicallAddress) throw "unknown multicall address";

        // call Arbitrum Node Interface for the calldata to get L1 gas
        const result = await config.viemClient.simulateContract({
            abi: ArbitrumNodeInterfaceAbi,
            address: ArbitrumNodeInterfaceAddress,
            functionName: "gasEstimateL1Component",
            args: [multicallAddress, false, calldata],
        });
        return config.quoteGas + result.result[0];
    } else {
        return config.quoteGas;
    }
}
