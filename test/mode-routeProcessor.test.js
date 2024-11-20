const { assert } = require("chai");
const testData = require("./data");
const { errorSnapshot } = require("../src/error");
const { estimateProfit } = require("../src/utils");
const {
    ethers,
    utils: { formatUnits },
} = require("ethers");
const { getBountyEnsureBytecode } = require("../src/config");
const {
    dryrun,
    findOpp,
    findOppWithRetries,
    RouteProcessorDryrunHaltReason,
} = require("../src/modes/routeProcessor");

// mocking signer and dataFetcher
let signer = {};
let dataFetcher = {};
const viemClient = {
    getBlockNumber: async () => BigInt(oppBlockNumber),
};

const oppBlockNumber = 123456;
const {
    inputToEthPrice: ethPrice,
    gasPrice,
    gasLimitEstimation,
    arb,
    vaultBalance,
    orderPairObject1: orderPairObject,
    fromToken,
    toToken,
    config,
    poolCodeMap,
    expectedRouteData,
    expectedRouteVisual,
    getCurrentPrice,
    getAmountOut,
} = testData;

describe("Test route processor dryrun", async function () {
    beforeEach(() => {
        signer = {
            account: { address: `0x${"1".repeat(40)}` },
            getBlockNumber: async () => oppBlockNumber,
            estimateGas: async () => gasLimitEstimation,
            getBalance: async () => ethers.BigNumber.from(0),
        };
        dataFetcher = {
            fetchedPairPools: [],
        };
    });

    it("should succeed", async function () {
        dataFetcher.getCurrentPoolCodeMap = () => {
            return poolCodeMap;
        };
        const result = await dryrun({
            mode: 0,
            orderPairObject,
            dataFetcher,
            fromToken,
            toToken,
            signer,
            maximumInput: vaultBalance,
            gasPrice,
            arb,
            ethPrice,
            config,
            viemClient,
            knownInitGas: { value: undefined },
        });
        const expectedTakeOrdersConfigStruct = {
            minimumInput: ethers.constants.One,
            maximumInput: vaultBalance,
            maximumIORatio: ethers.constants.MaxUint256,
            orders: [orderPairObject.takeOrders[0].takeOrder],
            data: expectedRouteData,
        };
        const task = {
            evaluable: {
                interpreter: orderPairObject.takeOrders[0].takeOrder.order.evaluable.interpreter,
                store: orderPairObject.takeOrders[0].takeOrder.order.evaluable.store,
                bytecode: getBountyEnsureBytecode(
                    ethers.utils.parseUnits(ethPrice),
                    ethers.constants.Zero,
                    gasLimitEstimation.mul(gasPrice),
                ),
            },
            signedContext: [],
        };
        const expected = {
            value: {
                rawtx: {
                    data: arb.interface.encodeFunctionData("arb3", [
                        orderPairObject.orderbook,
                        expectedTakeOrdersConfigStruct,
                        task,
                    ]),
                    to: arb.address,
                    gasPrice,
                    gas: gasLimitEstimation.toBigInt(),
                },
                maximumInput: vaultBalance,
                price: getCurrentPrice(vaultBalance),
                routeVisual: expectedRouteVisual,
                oppBlockNumber,
                estimatedProfit: estimateProfit(
                    orderPairObject,
                    ethers.utils.parseUnits(ethPrice),
                    undefined,
                    undefined,
                    getCurrentPrice(vaultBalance),
                    vaultBalance,
                ),
            },
            reason: undefined,
            spanAttributes: {
                oppBlockNumber,
                foundOpp: true,
                amountIn: formatUnits(vaultBalance),
                amountOut: formatUnits(getAmountOut(vaultBalance), 6),
                marketPrice: formatUnits(getCurrentPrice(vaultBalance)),
                route: expectedRouteVisual,
            },
        };
        assert.deepEqual(result, expected);
    });

    it("should fail with no route", async function () {
        dataFetcher.getCurrentPoolCodeMap = () => {
            return new Map();
        };
        try {
            await dryrun({
                mode: 0,
                orderPairObject,
                dataFetcher,
                fromToken,
                toToken,
                signer,
                maximumInput: vaultBalance,
                gasPrice,
                arb,
                ethPrice,
                config,
                viemClient,
                knownInitGas: { value: undefined },
            });
            assert.fail("expected to reject, but resolved");
        } catch (error) {
            const expected = {
                value: undefined,
                reason: RouteProcessorDryrunHaltReason.NoRoute,
                spanAttributes: {
                    amountIn: formatUnits(vaultBalance),
                    route: "no-way",
                },
            };
            assert.deepEqual(error, expected);
        }
    });

    it("should fail with no opp", async function () {
        dataFetcher.getCurrentPoolCodeMap = () => {
            return poolCodeMap;
        };
        signer.estimateGas = async () => {
            return Promise.reject(ethers.errors.UNPREDICTABLE_GAS_LIMIT);
        };
        try {
            await dryrun({
                mode: 0,
                orderPairObject,
                dataFetcher,
                fromToken,
                toToken,
                signer,
                maximumInput: vaultBalance,
                gasPrice,
                arb,
                ethPrice,
                config,
                viemClient,
                knownInitGas: { value: undefined },
            });
            assert.fail("expected to reject, but resolved");
        } catch (error) {
            const expectedTakeOrdersConfigStruct = {
                minimumInput: ethers.constants.One,
                maximumInput: vaultBalance,
                maximumIORatio: ethers.constants.MaxUint256,
                orders: [orderPairObject.takeOrders[0].takeOrder],
                data: expectedRouteData,
            };
            const task = {
                evaluable: {
                    interpreter:
                        orderPairObject.takeOrders[0].takeOrder.order.evaluable.interpreter,
                    store: orderPairObject.takeOrders[0].takeOrder.order.evaluable.store,
                    bytecode: getBountyEnsureBytecode(
                        ethers.utils.parseUnits(ethPrice),
                        ethers.constants.Zero,
                        ethers.constants.Zero,
                    ),
                },
                signedContext: [],
            };
            const rawtx = {
                data: arb.interface.encodeFunctionData("arb3", [
                    orderPairObject.orderbook,
                    expectedTakeOrdersConfigStruct,
                    task,
                ]),
                to: arb.address,
                gasPrice,
                from: signer.account.address,
            };
            const expected = {
                value: {
                    estimatedProfit: ethers.constants.Zero,
                    noneNodeError: `\nReason: ${ethers.errors.UNPREDICTABLE_GAS_LIMIT}`,
                },
                reason: RouteProcessorDryrunHaltReason.NoOpportunity,
                spanAttributes: {
                    marketPrice: formatUnits(getCurrentPrice(vaultBalance)),
                    amountIn: formatUnits(vaultBalance),
                    amountOut: formatUnits(getAmountOut(vaultBalance), 6),
                    blockNumber: oppBlockNumber,
                    error: errorSnapshot("", ethers.errors.UNPREDICTABLE_GAS_LIMIT),
                    route: expectedRouteVisual,
                    stage: 1,
                    rawtx: JSON.stringify(rawtx),
                    isNodeError: false,
                },
            };
            assert.deepEqual(error, expected);
        }
    });
});

describe("Test route processor find opp", async function () {
    beforeEach(() => {
        signer = {
            account: { address: `0x${"1".repeat(40)}` },
            getBlockNumber: async () => oppBlockNumber,
            estimateGas: async () => gasLimitEstimation,
            getBalance: async () => ethers.BigNumber.from(0),
        };
        dataFetcher = {
            fetchedPairPools: [],
        };
    });

    it("should find opp for full vault balance", async function () {
        dataFetcher.getCurrentPoolCodeMap = () => {
            return poolCodeMap;
        };
        const result = await findOpp({
            mode: 0,
            orderPairObject,
            dataFetcher,
            fromToken,
            toToken,
            signer,
            gasPrice,
            arb,
            ethPrice,
            config,
            viemClient,
        });
        const expectedTakeOrdersConfigStruct = {
            minimumInput: ethers.constants.One,
            maximumInput: vaultBalance,
            maximumIORatio: ethers.constants.MaxUint256,
            orders: [orderPairObject.takeOrders[0].takeOrder],
            data: expectedRouteData,
        };
        const task = {
            evaluable: {
                interpreter: orderPairObject.takeOrders[0].takeOrder.order.evaluable.interpreter,
                store: orderPairObject.takeOrders[0].takeOrder.order.evaluable.store,
                bytecode: getBountyEnsureBytecode(
                    ethers.utils.parseUnits(ethPrice),
                    ethers.constants.Zero,
                    gasLimitEstimation.mul(gasPrice),
                ),
            },
            signedContext: [],
        };
        const expected = {
            value: {
                rawtx: {
                    data: arb.interface.encodeFunctionData("arb3", [
                        orderPairObject.orderbook,
                        expectedTakeOrdersConfigStruct,
                        task,
                    ]),
                    to: arb.address,
                    gasPrice,
                    gas: gasLimitEstimation.toBigInt(),
                },
                maximumInput: vaultBalance,
                price: getCurrentPrice(vaultBalance),
                routeVisual: expectedRouteVisual,
                oppBlockNumber,
                estimatedProfit: estimateProfit(
                    orderPairObject,
                    ethers.utils.parseUnits(ethPrice),
                    undefined,
                    undefined,
                    getCurrentPrice(vaultBalance),
                    vaultBalance,
                ),
            },
            reason: undefined,
            spanAttributes: {
                oppBlockNumber,
                foundOpp: true,
                amountIn: formatUnits(vaultBalance),
                amountOut: formatUnits(getAmountOut(vaultBalance), 6),
                marketPrice: formatUnits(getCurrentPrice(vaultBalance)),
                route: expectedRouteVisual,
            },
        };
        assert.deepEqual(result, expected);
    });

    it("should find opp with binary search", async function () {
        dataFetcher.getCurrentPoolCodeMap = () => {
            return poolCodeMap;
        };
        // mock the signer to reject the first attempt on gas estimation
        // so the dryrun goes into binary search
        let rejectFirst = true;
        signer.estimateGas = async () => {
            if (rejectFirst) {
                rejectFirst = false;
                return Promise.reject(ethers.errors.UNPREDICTABLE_GAS_LIMIT);
            } else return gasLimitEstimation;
        };
        const result = await findOpp({
            mode: 0,
            orderPairObject,
            dataFetcher,
            fromToken,
            toToken,
            signer,
            gasPrice,
            arb,
            ethPrice,
            config,
            viemClient,
        });
        const expectedTakeOrdersConfigStruct = {
            minimumInput: ethers.constants.One,
            maximumInput: vaultBalance.mul(3).div(4),
            maximumIORatio: ethers.constants.MaxUint256,
            orders: [orderPairObject.takeOrders[0].takeOrder],
            data: expectedRouteData,
        };
        const task = {
            evaluable: {
                interpreter: orderPairObject.takeOrders[0].takeOrder.order.evaluable.interpreter,
                store: orderPairObject.takeOrders[0].takeOrder.order.evaluable.store,
                bytecode: getBountyEnsureBytecode(
                    ethers.utils.parseUnits(ethPrice),
                    ethers.constants.Zero,
                    gasLimitEstimation.mul(gasPrice),
                ),
            },
            signedContext: [],
        };
        const expected = {
            value: {
                rawtx: {
                    data: arb.interface.encodeFunctionData("arb3", [
                        orderPairObject.orderbook,
                        expectedTakeOrdersConfigStruct,
                        task,
                    ]),
                    to: arb.address,
                    gasPrice,
                    gas: gasLimitEstimation.toBigInt(),
                },
                maximumInput: vaultBalance.mul(3).div(4),
                price: getCurrentPrice(vaultBalance.sub(vaultBalance.div(4))),
                routeVisual: expectedRouteVisual,
                oppBlockNumber,
                estimatedProfit: estimateProfit(
                    orderPairObject,
                    ethers.utils.parseUnits(ethPrice),
                    undefined,
                    undefined,
                    getCurrentPrice(vaultBalance.mul(3).div(4)),
                    vaultBalance.mul(3).div(4),
                ),
            },
            reason: undefined,
            spanAttributes: {
                oppBlockNumber,
                foundOpp: true,
                amountIn: formatUnits(vaultBalance.mul(3).div(4)),
                amountOut: formatUnits(getAmountOut(vaultBalance.mul(3).div(4)), 6),
                marketPrice: formatUnits(getCurrentPrice(vaultBalance.sub(vaultBalance.div(4)))),
                route: expectedRouteVisual,
            },
        };
        assert.deepEqual(result, expected);
    });

    it("should NOT find opp", async function () {
        dataFetcher.getCurrentPoolCodeMap = () => {
            return poolCodeMap;
        };
        signer.estimateGas = async () => {
            return Promise.reject(ethers.errors.UNPREDICTABLE_GAS_LIMIT);
        };
        try {
            await findOpp({
                mode: 0,
                orderPairObject,
                dataFetcher,
                fromToken,
                toToken,
                signer,
                gasPrice,
                arb,
                ethPrice,
                config,
                viemClient,
            });
            assert.fail("expected to reject, but resolved");
        } catch (error) {
            const expectedTakeOrdersConfigStruct = {
                minimumInput: ethers.constants.One,
                maximumInput: vaultBalance,
                maximumIORatio: ethers.constants.MaxUint256,
                orders: [orderPairObject.takeOrders[0].takeOrder],
                data: expectedRouteData,
            };
            const task = {
                evaluable: {
                    interpreter:
                        orderPairObject.takeOrders[0].takeOrder.order.evaluable.interpreter,
                    store: orderPairObject.takeOrders[0].takeOrder.order.evaluable.store,
                    bytecode: getBountyEnsureBytecode(
                        ethers.utils.parseUnits(ethPrice),
                        ethers.constants.Zero,
                        ethers.constants.Zero,
                    ),
                },
                signedContext: [],
            };
            const rawtx = JSON.stringify({
                data: arb.interface.encodeFunctionData("arb3", [
                    orderPairObject.orderbook,
                    expectedTakeOrdersConfigStruct,
                    task,
                ]),
                to: arb.address,
                gasPrice,
                from: signer.account.address,
            });
            const expected = {
                value: {
                    estimatedProfit: ethers.constants.Zero,
                    noneNodeError: `\nReason: ${ethers.errors.UNPREDICTABLE_GAS_LIMIT}`,
                },
                reason: RouteProcessorDryrunHaltReason.NoOpportunity,
                spanAttributes: {
                    hops: [
                        `{"amountIn":"${formatUnits(vaultBalance)}","amountOut":"${formatUnits(getAmountOut(vaultBalance), 6)}","marketPrice":"${formatUnits(getCurrentPrice(vaultBalance))}","route":${JSON.stringify(expectedRouteVisual)},"blockNumber":${oppBlockNumber},"stage":1,"isNodeError":false,"error":${JSON.stringify(errorSnapshot("", ethers.errors.UNPREDICTABLE_GAS_LIMIT))},"rawtx":${JSON.stringify(rawtx)}}`,
                        `{"amountIn":"${formatUnits(vaultBalance.div(2))}","amountOut":"${formatUnits(getAmountOut(vaultBalance.div(2)), 6)}","marketPrice":"${formatUnits(getCurrentPrice(vaultBalance.div(2)))}","route":${JSON.stringify(expectedRouteVisual)},"blockNumber":${oppBlockNumber},"stage":1,"isNodeError":false}`,
                        `{"amountIn":"${formatUnits(vaultBalance.div(4))}","amountOut":"${formatUnits(getAmountOut(vaultBalance.div(4)), 6)}","marketPrice":"${formatUnits(getCurrentPrice(vaultBalance.div(4)))}","route":${JSON.stringify(expectedRouteVisual)},"blockNumber":${oppBlockNumber},"stage":1,"isNodeError":false}`,
                    ],
                },
            };
            assert.deepEqual(error, expected);
        }
    });

    it("should find no route", async function () {
        dataFetcher.getCurrentPoolCodeMap = () => {
            return new Map();
        };
        try {
            await findOpp({
                mode: 0,
                orderPairObject,
                dataFetcher,
                fromToken,
                toToken,
                signer,
                gasPrice,
                arb,
                ethPrice,
                config,
                viemClient,
            });
            assert.fail("expected to reject, but resolved");
        } catch (error) {
            const expected = {
                value: undefined,
                reason: RouteProcessorDryrunHaltReason.NoRoute,
                spanAttributes: {
                    hops: [
                        `{"amountIn":"${formatUnits(vaultBalance)}","route":"no-way"}`,
                        `{"amountIn":"${formatUnits(vaultBalance.div(2))}","route":"no-way"}`,
                        `{"amountIn":"${formatUnits(vaultBalance.div(4))}","route":"no-way"}`,
                    ],
                },
            };
            assert.deepEqual(error, expected);
        }
    });
});

describe("Test find opp with retries", async function () {
    beforeEach(() => {
        signer = {
            account: { address: `0x${"1".repeat(40)}` },
            getBlockNumber: async () => oppBlockNumber,
            estimateGas: async () => gasLimitEstimation,
            getBalance: async () => ethers.BigNumber.from(0),
        };
        dataFetcher = {
            fetchedPairPools: [],
        };
    });

    it("should find opp with 2 retries", async function () {
        dataFetcher.getCurrentPoolCodeMap = () => {
            return poolCodeMap;
        };
        let rejectFirst = true;
        signer.estimateGas = async () => {
            if (rejectFirst) {
                rejectFirst = false;
                return Promise.reject(ethers.errors.UNPREDICTABLE_GAS_LIMIT);
            } else return gasLimitEstimation;
        };
        const result = await findOppWithRetries({
            orderPairObject,
            dataFetcher,
            fromToken,
            toToken,
            signer,
            gasPrice,
            arb,
            ethPrice,
            config,
            viemClient,
        });
        const expectedTakeOrdersConfigStruct = {
            minimumInput: ethers.constants.One,
            maximumInput: vaultBalance,
            maximumIORatio: ethers.constants.MaxUint256,
            orders: [
                orderPairObject.takeOrders[0].takeOrder,
                orderPairObject.takeOrders[0].takeOrder,
            ],
            data: expectedRouteData,
        };
        const task = {
            evaluable: {
                interpreter: orderPairObject.takeOrders[0].takeOrder.order.evaluable.interpreter,
                store: orderPairObject.takeOrders[0].takeOrder.order.evaluable.store,
                bytecode: getBountyEnsureBytecode(
                    ethers.utils.parseUnits(ethPrice),
                    ethers.constants.Zero,
                    gasLimitEstimation.mul(gasPrice),
                ),
            },
            signedContext: [],
        };
        const expected = {
            value: {
                rawtx: {
                    data: arb.interface.encodeFunctionData("arb3", [
                        orderPairObject.orderbook,
                        expectedTakeOrdersConfigStruct,
                        task,
                    ]),
                    to: arb.address,
                    gasPrice,
                    gas: gasLimitEstimation.toBigInt(),
                },
                maximumInput: vaultBalance,
                price: getCurrentPrice(vaultBalance),
                routeVisual: expectedRouteVisual,
                oppBlockNumber,
                estimatedProfit: estimateProfit(
                    orderPairObject,
                    ethers.utils.parseUnits(ethPrice),
                    undefined,
                    undefined,
                    getCurrentPrice(vaultBalance),
                    vaultBalance,
                ),
            },
            reason: undefined,
            spanAttributes: {
                oppBlockNumber,
                foundOpp: true,
                amountIn: formatUnits(vaultBalance),
                amountOut: formatUnits(getAmountOut(vaultBalance), 6),
                marketPrice: formatUnits(getCurrentPrice(vaultBalance)),
                route: expectedRouteVisual,
            },
        };
        assert.deepEqual(result, expected);
    });

    it("should NOT find opp", async function () {
        dataFetcher.getCurrentPoolCodeMap = () => {
            return poolCodeMap;
        };
        signer.estimateGas = async () => {
            return Promise.reject(ethers.errors.UNPREDICTABLE_GAS_LIMIT);
        };
        try {
            await findOppWithRetries({
                orderPairObject,
                dataFetcher,
                fromToken,
                toToken,
                signer,
                gasPrice,
                arb,
                ethPrice,
                config,
                viemClient,
            });
            assert.fail("expected to reject, but resolved");
        } catch (error) {
            const expectedTakeOrdersConfigStruct = {
                minimumInput: ethers.constants.One,
                maximumInput: vaultBalance,
                maximumIORatio: ethers.constants.MaxUint256,
                orders: [orderPairObject.takeOrders[0].takeOrder],
                data: expectedRouteData,
            };
            const task = {
                evaluable: {
                    interpreter:
                        orderPairObject.takeOrders[0].takeOrder.order.evaluable.interpreter,
                    store: orderPairObject.takeOrders[0].takeOrder.order.evaluable.store,
                    bytecode: getBountyEnsureBytecode(
                        ethers.utils.parseUnits(ethPrice),
                        ethers.constants.Zero,
                        ethers.constants.Zero,
                    ),
                },
                signedContext: [],
            };
            const rawtx = JSON.stringify({
                data: arb.interface.encodeFunctionData("arb3", [
                    orderPairObject.orderbook,
                    expectedTakeOrdersConfigStruct,
                    task,
                ]),
                to: arb.address,
                gasPrice,
                from: signer.account.address,
            });
            const expected = {
                value: {
                    estimatedProfit: ethers.constants.Zero,
                    noneNodeError: `\nReason: ${ethers.errors.UNPREDICTABLE_GAS_LIMIT}`,
                },
                reason: RouteProcessorDryrunHaltReason.NoOpportunity,
                spanAttributes: {
                    hops: [
                        `{"amountIn":"${formatUnits(vaultBalance)}","amountOut":"${formatUnits(getAmountOut(vaultBalance), 6)}","marketPrice":"${formatUnits(getCurrentPrice(vaultBalance))}","route":${JSON.stringify(expectedRouteVisual)},"blockNumber":${oppBlockNumber},"stage":1,"isNodeError":false,"error":${JSON.stringify(errorSnapshot("", ethers.errors.UNPREDICTABLE_GAS_LIMIT))},"rawtx":${JSON.stringify(rawtx)}}`,
                        `{"amountIn":"${formatUnits(vaultBalance.div(2))}","amountOut":"${formatUnits(getAmountOut(vaultBalance.div(2)), 6)}","marketPrice":"${formatUnits(getCurrentPrice(vaultBalance.div(2)))}","route":${JSON.stringify(expectedRouteVisual)},"blockNumber":${oppBlockNumber},"stage":1,"isNodeError":false}`,
                        `{"amountIn":"${formatUnits(vaultBalance.div(4))}","amountOut":"${formatUnits(getAmountOut(vaultBalance.div(4)), 6)}","marketPrice":"${formatUnits(getCurrentPrice(vaultBalance.div(4)))}","route":${JSON.stringify(expectedRouteVisual)},"blockNumber":${oppBlockNumber},"stage":1,"isNodeError":false}`,
                    ],
                },
            };
            assert.deepEqual(error, expected);
        }
    });

    it("should find no route", async function () {
        dataFetcher.getCurrentPoolCodeMap = () => {
            return new Map();
        };
        try {
            await findOppWithRetries({
                orderPairObject,
                dataFetcher,
                fromToken,
                toToken,
                signer,
                gasPrice,
                arb,
                ethPrice,
                config,
                viemClient,
            });
            assert.fail("expected to reject, but resolved");
        } catch (error) {
            const expected = {
                value: undefined,
                reason: RouteProcessorDryrunHaltReason.NoRoute,
                spanAttributes: { route: "no-way" },
            };
            assert.deepEqual(error, expected);
        }
    });
});
