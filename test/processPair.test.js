const { assert } = require("chai");
const fixtures = require("./data");
const { clone } = require("../src/utils");
const mockServer = require("mockttp").getLocal();
const { encodeQuoteResponse } = require("./utils");
const { ethers, utils: { formatUnits } } = require("ethers");
const { processPair, ProcessPairHaltReason, ProcessPairReportStatus } = require("../src/processOrders");

describe("Test process pair", async function () {
    // mock dataFecther, ethers signer and viem client
    let dataFetcher = {};
    let signer = {};
    let viemClient = {};

    const {
        gasPrice,
        gasLimitEstimation,
        arb,
        vaultBalance,
        orderPairObject1: orderPairObject,
        config: fixtureConfig,
        poolCodeMap,
        expectedRouteVisual,
        pair,
        orderbook,
        txHash,
        effectiveGasPrice,
        gasUsed,
        scannerUrl,
        getCurrentPrice,
        expectedRouteData,
        getCurrentInputToEthPrice,
        orderbooksOrders,
    } = fixtures;
    const config = JSON.parse(JSON.stringify(fixtureConfig));
    config.rpc = ["http://localhost:8082/rpc"];
    const quoteResponse = encodeQuoteResponse([[true, vaultBalance, ethers.constants.Zero]]);

    beforeEach(() => {
        mockServer.start(8082);
        config.gasCoveragePercentage = "0";
        signer = {
            BALANCE: ethers.BigNumber.from(0),
            BOUNTY: [],
            getAddress: () => "0x1F1E4c845183EF6d50E9609F16f6f9cAE43BC9Cb",
            provider: {
                getBlockNumber: async () => 123456,
                getGasPrice: async () => gasPrice,
            },
            estimateGas: async () => gasLimitEstimation,
            sendTransaction: async () => {
                return {
                    hash: txHash,
                    wait: async () => {
                        return {
                            status: 1,
                            effectiveGasPrice,
                            gasUsed,
                            logs: [],
                            events: [],
                        };
                    }
                };
            }
        };
        dataFetcher = {
            fetchPoolsForToken: async () => {}
        };
        viemClient = {
            chain: { id: 137 },
            multicall: async () => [vaultBalance.toBigInt()],
            getGasPrice: async () => gasPrice.toBigInt(),
            getBlockNumber: async () => 123456n,
        };
    });
    afterEach(() => mockServer.stop());

    it("should process pair successfully from RP", async function () {
        await mockServer.forPost("/rpc").thenSendJsonRpcResult(quoteResponse);
        dataFetcher.getCurrentPoolCodeMap = () => {
            return poolCodeMap;
        };
        const result = await processPair({
            config,
            orderPairObject,
            viemClient,
            dataFetcher,
            signer,
            arb,
            orderbook,
            pair,
            mainAccount: signer,
            accounts: [signer],
            fetchedPairPools: [],
            orderbooksOrders,
        });
        const expected = {
            report: {
                status: ProcessPairReportStatus.FoundOpportunity,
                txUrl: scannerUrl + "/tx/" + txHash,
                tokenPair: pair,
                buyToken: orderPairObject.buyToken,
                sellToken: orderPairObject.sellToken,
                clearedAmount: undefined,
                actualGasCost: formatUnits(effectiveGasPrice.mul(gasUsed)),
                income: undefined,
                netProfit: undefined,
                clearedOrders: [orderPairObject.takeOrders[0].id],
                inputTokenIncome: undefined,
                outputTokenIncome: undefined,
            },
            reason: undefined,
            error: undefined,
            gasCost: gasPrice.mul(gasUsed),
            spanAttributes: {
                "details.blockNumber": 123456,
                "details.blockNumberDiff": 0,
                "details.marketPrice": formatUnits(getCurrentPrice(vaultBalance)),
                "details.maxInput": vaultBalance.toString(),
                "oppBlockNumber": 123456,
                "details.orders": [orderPairObject.takeOrders[0].id],
                "details.route": expectedRouteVisual,
                "details.tx": `{"hash":"${txHash}"}`,
                "details.txUrl": scannerUrl + "/tx/" + txHash,
                "details.pair": pair,
                "details.gasPrice": gasPrice.toString(),
                "foundOpp": true,
                "didClear": true,
                "details.ethPriceToInput": formatUnits(getCurrentInputToEthPrice()),
                "details.ethPriceToOutput": "1",
            }
        };
        assert.deepEqual(result, expected);
    });

    it("should process pair successfully from inter-orderbook", async function () {
        await mockServer.forPost("/rpc").thenSendJsonRpcResult(quoteResponse);
        dataFetcher.getCurrentPoolCodeMap = () => {
            return poolCodeMap;
        };
        const result = await processPair({
            config,
            orderPairObject,
            viemClient,
            dataFetcher,
            signer,
            arb,
            genericArb: arb,
            orderbook,
            pair,
            mainAccount: signer,
            accounts: [signer],
            fetchedPairPools: [],
            orderbooksOrders,
        });
        const expected = {
            report: {
                status: ProcessPairReportStatus.FoundOpportunity,
                txUrl: scannerUrl + "/tx/" + txHash,
                tokenPair: pair,
                buyToken: orderPairObject.buyToken,
                sellToken: orderPairObject.sellToken,
                clearedAmount: undefined,
                actualGasCost: formatUnits(effectiveGasPrice.mul(gasUsed)),
                income: undefined,
                netProfit: undefined,
                clearedOrders: [orderPairObject.takeOrders[0].id],
                inputTokenIncome: undefined,
                outputTokenIncome: undefined,
            },
            reason: undefined,
            error: undefined,
            gasCost: gasPrice.mul(gasUsed),
            spanAttributes: {
                "details.blockNumber": 123456,
                "details.blockNumberDiff": 0,
                "details.maxInput": vaultBalance.toString(),
                "oppBlockNumber": 123456,
                "details.orders": [orderPairObject.takeOrders[0].id],
                "details.tx": `{"hash":"${txHash}"}`,
                "details.txUrl": scannerUrl + "/tx/" + txHash,
                "details.pair": pair,
                "details.gasPrice": gasPrice.toString(),
                "foundOpp": true,
                "didClear": true,
                "details.ethPriceToInput": formatUnits(getCurrentInputToEthPrice()),
                "details.ethPriceToOutput": "1",
            }
        };
        assert.deepEqual(result, expected);
    });

    it("should have no output", async function () {
        // set quote max output to zero
        await mockServer
            .forPost("/rpc")
            .thenSendJsonRpcResult(encodeQuoteResponse([
                [true, ethers.constants.Zero, ethers.constants.Zero]
            ]));
        const orderPairObjectCopy = clone(orderPairObject);
        const result = await processPair({
            config,
            orderPairObject: orderPairObjectCopy,
            viemClient,
            dataFetcher,
            signer,
            flashbotSigner: undefined,
            arb,
            orderbook,
            pair,
            mainAccount: signer,
            accounts: [signer],
            fetchedPairPools: [],
        });
        const expected = {
            reason: undefined,
            error: undefined,
            gasCost: undefined,
            report: {
                status: ProcessPairReportStatus.ZeroOutput,
                tokenPair: pair,
                buyToken: orderPairObject.buyToken,
                sellToken: orderPairObject.sellToken,
            },
            spanAttributes: {
                "details.orders": [orderPairObject.takeOrders[0].id],
                "details.pair": pair
            }
        };
        assert.deepEqual(result, expected);
    });

    it("should fail to quote order", async function () {
        await mockServer.forPost("/rpc").thenSendJsonRpcError();
        try {
            await processPair({
                config,
                orderPairObject,
                viemClient,
                dataFetcher,
                signer,
                flashbotSigner: undefined,
                arb,
                orderbook,
                pair,
                mainAccount: signer,
                accounts: [signer],
                fetchedPairPools: [],
            });
            assert.fail("expected to reject, but resolved");
        } catch(error) {
            const expected = {
                report: undefined,
                gasCost: undefined,
                reason: ProcessPairHaltReason.FailedToQuote,
                error: "Execution reverted with unknown error. Data: \"\" ",
                spanAttributes: {
                    "details.pair": pair,
                    "details.orders": [orderPairObject.takeOrders[0].id]
                }
            };
            assert.deepEqual(error, expected);
        }
    });

    it("should fail to get gas price", async function () {
        await mockServer.forPost("/rpc").thenSendJsonRpcResult(quoteResponse);
        const evmError = { code: ethers.errors.CALL_EXCEPTION };
        viemClient.getGasPrice = async () => {
            return Promise.reject(evmError);
        };
        try {
            await processPair({
                config,
                orderPairObject,
                viemClient,
                dataFetcher,
                signer,
                flashbotSigner: undefined,
                arb,
                orderbook,
                pair,
                mainAccount: signer,
                accounts: [signer],
                fetchedPairPools: [],
            });
            assert.fail("expected to reject, but resolved");
        } catch(error) {
            const expected = {
                report: undefined,
                gasCost: undefined,
                reason: ProcessPairHaltReason.FailedToGetGasPrice,
                error: evmError,
                spanAttributes: {
                    "details.pair": pair,
                    "details.orders": [orderPairObject.takeOrders[0].id]
                }
            };
            assert.deepEqual(error, expected);
        }
    });

    it("should fail to get eth price", async function () {
        await mockServer.forPost("/rpc").thenSendJsonRpcResult(quoteResponse);
        config.gasCoveragePercentage = "100";
        dataFetcher.getCurrentPoolCodeMap = () => {
            return new Map();
        };
        try {
            await processPair({
                config,
                orderPairObject,
                viemClient,
                dataFetcher,
                signer,
                flashbotSigner: undefined,
                arb,
                orderbook,
                pair,
                mainAccount: signer,
                accounts: [signer],
                fetchedPairPools: [],
            });
            assert.fail("expected to reject, but resolved");
        } catch(error) {
            const expected = {
                report: undefined,
                gasCost: undefined,
                reason: ProcessPairHaltReason.FailedToGetEthPrice,
                error: undefined,
                spanAttributes: {
                    "details.pair": pair,
                    "details.orders": [orderPairObject.takeOrders[0].id],
                    "details.gasPrice": gasPrice.toString()
                }
            };
            assert.deepEqual(error, expected);
        }
    });

    it("should fail to get pools", async function () {
        await mockServer.forPost("/rpc").thenSendJsonRpcResult(quoteResponse);
        const evmError = { code: ethers.errors.CALL_EXCEPTION };
        dataFetcher.fetchPoolsForToken = () => {
            return Promise.reject(evmError);
        };
        try {
            await processPair({
                config,
                orderPairObject,
                viemClient,
                dataFetcher,
                signer,
                flashbotSigner: undefined,
                arb,
                orderbook,
                pair,
                mainAccount: signer,
                accounts: [signer],
                fetchedPairPools: [],
            });
            assert.fail("expected to reject, but resolved");
        } catch(error) {
            const expected = {
                report: undefined,
                gasCost: undefined,
                reason: ProcessPairHaltReason.FailedToGetPools,
                error: evmError,
                spanAttributes: {
                    "details.pair": pair,
                    "details.orders": [orderPairObject.takeOrders[0].id],
                    "details.gasPrice": gasPrice.toString()
                }
            };
            assert.deepEqual(error, expected);
        }
    });

    it("should fail tx", async function () {
        await mockServer.forPost("/rpc").thenSendJsonRpcResult(quoteResponse);
        const evmError = { code: ethers.errors.CALL_EXCEPTION };
        dataFetcher.getCurrentPoolCodeMap = () => {
            return poolCodeMap;
        };
        signer.sendTransaction = async () => {
            return Promise.reject(evmError);
        };
        try {
            await processPair({
                config,
                orderPairObject,
                viemClient,
                dataFetcher,
                signer,
                flashbotSigner: undefined,
                arb,
                orderbook,
                pair,
                mainAccount: signer,
                accounts: [signer],
                fetchedPairPools: [],
            });
            assert.fail("expected to reject, but resolved");
        } catch(error) {
            const expectedTakeOrdersConfigStruct = {
                minimumInput: ethers.constants.One,
                maximumInput: vaultBalance,
                maximumIORatio: ethers.constants.MaxUint256,
                orders: [orderPairObject.takeOrders[0].takeOrder],
                data: expectedRouteData
            };
            const task = {
                evaluable: {
                    interpreter: orderPairObject
                        .takeOrders[0].takeOrder.order.evaluable.interpreter,
                    store: orderPairObject.takeOrders[0].takeOrder.order.evaluable.store,
                    bytecode: "0x"
                },
                signedContext: []
            };
            const rawtx = {
                data: arb.interface.encodeFunctionData(
                    "arb3",
                    [
                        orderPairObject.orderbook,
                        expectedTakeOrdersConfigStruct,
                        task,
                    ]
                ),
                to: arb.address,
                gasPrice,
                gasLimit: gasLimitEstimation.mul("107").div("100"),
            };
            const expected = {
                report: {
                    status: ProcessPairReportStatus.FoundOpportunity,
                    tokenPair: pair,
                    buyToken: orderPairObject.buyToken,
                    sellToken: orderPairObject.sellToken,
                },
                reason: ProcessPairHaltReason.TxFailed,
                gasCost: undefined,
                error: evmError,
                spanAttributes: {
                    "details.pair": pair,
                    "details.orders": [orderPairObject.takeOrders[0].id],
                    "details.gasPrice": gasPrice.toString(),
                    "details.blockNumber": 123456,
                    "details.blockNumberDiff": 0,
                    "details.marketPrice": formatUnits(getCurrentPrice(vaultBalance)),
                    "details.maxInput": vaultBalance.toString(),
                    "oppBlockNumber": 123456,
                    "details.route": expectedRouteVisual,
                    "foundOpp": true,
                    "details.rawTx": JSON.stringify(rawtx),
                    "details.ethPriceToInput": formatUnits(getCurrentInputToEthPrice()),
                    "details.ethPriceToOutput": "1",
                }
            };
            assert.deepEqual(error, expected);
        }
    });

    it("should fail to mine tx with rejection", async function () {
        await mockServer.forPost("/rpc").thenSendJsonRpcResult(quoteResponse);
        const evmError = {
            status: 0,
            code: ethers.errors.CALL_EXCEPTION
        };
        dataFetcher.getCurrentPoolCodeMap = () => {
            return poolCodeMap;
        };
        signer.sendTransaction = async () => {
            return {
                hash: txHash,
                wait: async () => { throw evmError; }
            };
        };
        try {
            await processPair({
                config,
                orderPairObject,
                viemClient,
                dataFetcher,
                signer,
                flashbotSigner: undefined,
                arb,
                orderbook,
                pair,
                mainAccount: signer,
                accounts: [signer],
                fetchedPairPools: [],
            });
            assert.fail("expected to reject, but resolved");
        } catch(error) {
            const expected = {
                report: {
                    status: ProcessPairReportStatus.FoundOpportunity,
                    tokenPair: pair,
                    buyToken: orderPairObject.buyToken,
                    sellToken: orderPairObject.sellToken,
                    txUrl: scannerUrl + "/tx/" + txHash,
                },
                reason: ProcessPairHaltReason.TxMineFailed,
                error: evmError,
                gasCost: undefined,
                spanAttributes: {
                    "details.pair": pair,
                    "details.orders": [orderPairObject.takeOrders[0].id],
                    "details.gasPrice": gasPrice.toString(),
                    "details.blockNumber": 123456,
                    "details.blockNumberDiff": 0,
                    "details.marketPrice": formatUnits(getCurrentPrice(vaultBalance)),
                    "details.maxInput": vaultBalance.toString(),
                    "oppBlockNumber": 123456,
                    "details.route": expectedRouteVisual,
                    "foundOpp": true,
                    "details.tx": `{"hash":"${txHash}"}`,
                    "details.txUrl": scannerUrl + "/tx/" + txHash,
                    "details.ethPriceToInput": formatUnits(getCurrentInputToEthPrice()),
                    "details.ethPriceToOutput": "1",
                }
            };
            assert.deepEqual(error, expected);
        }
    });

    it("should fail to mine tx with resolve", async function () {
        await mockServer.forPost("/rpc").thenSendJsonRpcResult(quoteResponse);
        const errorReceipt = {
            status: 0,
            code: ethers.errors.CALL_EXCEPTION,
            gasUsed,
            effectiveGasPrice,
        };
        dataFetcher.getCurrentPoolCodeMap = () => {
            return poolCodeMap;
        };
        signer.sendTransaction = async () => {
            return {
                hash: txHash,
                wait: async () => { return errorReceipt; }
            };
        };
        try {
            await processPair({
                config,
                orderPairObject,
                viemClient,
                dataFetcher,
                signer,
                flashbotSigner: undefined,
                arb,
                orderbook,
                pair,
                mainAccount: signer,
                accounts: [signer],
                fetchedPairPools: [],
            });
            assert.fail("expected to reject, but resolved");
        } catch(error) {
            const expected = {
                report: {
                    status: ProcessPairReportStatus.FoundOpportunity,
                    tokenPair: pair,
                    buyToken: orderPairObject.buyToken,
                    sellToken: orderPairObject.sellToken,
                    txUrl: scannerUrl + "/tx/" + txHash,
                    actualGasCost: ethers.utils.formatUnits(effectiveGasPrice.mul(gasUsed)),
                },
                reason: ProcessPairHaltReason.TxMineFailed,
                error: undefined,
                gasCost: undefined,
                spanAttributes: {
                    "details.pair": pair,
                    "details.orders": [orderPairObject.takeOrders[0].id],
                    "details.gasPrice": gasPrice.toString(),
                    "details.blockNumber": 123456,
                    "details.blockNumberDiff": 0,
                    "details.marketPrice": formatUnits(getCurrentPrice(vaultBalance)),
                    "details.maxInput": vaultBalance.toString(),
                    "oppBlockNumber": 123456,
                    "details.route": expectedRouteVisual,
                    "foundOpp": true,
                    "details.tx": `{"hash":"${txHash}"}`,
                    "details.txUrl": scannerUrl + "/tx/" + txHash,
                    "details.receipt": JSON.stringify(errorReceipt),
                    "details.ethPriceToInput": formatUnits(getCurrentInputToEthPrice()),
                    "details.ethPriceToOutput": "1",
                }
            };
            assert.deepEqual(error, expected);
        }
    });
});
