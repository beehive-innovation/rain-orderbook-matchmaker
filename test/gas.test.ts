import { assert } from "chai";
import { ChainId } from "sushi";
import { orderPairObject1 } from "./data";
import { OperationState, ViemClient } from "../src/types";
import { estimateGasCost, getGasPrice, getL1Fee, getQuoteGas, getTxFee } from "../src/tx";

describe("Test gas", async function () {
    it("should estimate gas correctly for L1 and L2 chains", async function () {
        // mock config
        const config = {
            isSpecialL2: true,
            gasPriceMultiplier: 100n,
        } as any;
        // mock L1 signer for L2 client
        const l1Signer = {
            getL1BaseFee: async () => 20n,
            estimateL1Fee: async () => 5n,
        };
        // mock normal L1 signer
        const signer = {
            estimateGas: async () => 55n,
            getGasPrice: async () => 2n,
        } as any as ViemClient;
        // mock tx
        const tx = {
            data: "0x1234" as `0x${string}`,
            to: ("0x" + "1".repeat(40)) as `0x${string}`,
        };

        // estimate gas as special L2 chain
        const result1 = await estimateGasCost(tx, signer, config, undefined, l1Signer);
        const expected1 = {
            gas: 55n,
            gasPrice: 2n,
            l1GasPrice: 20n,
            l1Cost: 5n,
            totalGasCost: 2n * 55n + 5n,
        };
        assert.deepEqual(result1, expected1);

        // estimate as L1 chain
        config.isSpecialL2 = false;
        const result2 = await estimateGasCost(tx, signer, config);
        const expected2 = {
            gas: 55n,
            gasPrice: 2n,
            l1GasPrice: 0n,
            l1Cost: 0n,
            totalGasCost: 2n * 55n,
        };
        assert.deepEqual(result2, expected2);
    });

    it("should get L1 fee from receipt", async function () {
        // mock config
        const config = {
            isSpecialL2: true,
        } as any;

        // chain is L1, no L1 fee in receipt
        const receipt1 = {
            effectiveGasPrice: 10n,
            gasUsed: 5n,
        } as any;
        assert.equal(getL1Fee(receipt1, config), 0n);

        // L2
        config.isSpecialL2 = true;
        const receipt2 = {
            effectiveGasPrice: 10n,
            gasUsed: 5n,
            l1Fee: 6n,
            l1GasPrice: 2n,
            l1GasUsed: 3n,
        } as any;
        assert.equal(getL1Fee(receipt2, config), 6n);
    });

    it("should get tx fee", async function () {
        // mock config and receipt
        const config = {
            chain: { id: 137 },
        } as any;
        const receipt = {
            effectiveGasPrice: 10n,
            gasUsed: 5n,
        } as any;

        // L1
        let result = getTxFee(receipt, config);
        assert.equal(result, 50n);

        // L2
        config.isSpecialL2 = true;
        receipt.l1Fee = 50n;
        result = getTxFee(receipt, config);
        assert.equal(result, 100n);
    });

    it("should get gas price", async function () {
        const gasPrice = 10n;
        const l1GasPrice = 2n;
        // mock config and viem client
        const config = {
            chain: { id: 137 },
            isSpecialL2: false,
            gasPriceMultiplier: 100n,
            viemClient: { getGasPrice: async () => gasPrice },
        } as any;

        // test L1 chain
        const state1: OperationState = {
            gasPrice: 0n,
            l1GasPrice: 0n,
        };
        await getGasPrice(config, state1);
        assert.equal(state1.gasPrice, gasPrice);
        assert.equal(state1.l1GasPrice, 0n);

        // test L2 chain
        config.isSpecialL2 = true;
        config.viemClient.extend = () => config.viemClient;
        config.viemClient.getL1BaseFee = async () => l1GasPrice;
        const state2: OperationState = {
            gasPrice: 0n,
            l1GasPrice: 0n,
        };
        await getGasPrice(config, state2);
        assert.equal(state2.gasPrice, gasPrice);
        assert.equal(state2.l1GasPrice, l1GasPrice);
    });

    it("should get quote gas", async function () {
        const limitGas = 1_000_000n;
        const arbitrumL1Gas = 2_000_000n;
        const multicallAddress = "0x" + "1".repeat(40);

        // mock order and bot config and viem client
        const orderDetails = orderPairObject1;
        const config = {
            chain: {
                id: ChainId.ARBITRUM,
            },
            quoteGas: limitGas,
            viemClient: {
                simulateContract: async () => ({ result: [arbitrumL1Gas, 1_500_000n, 123_000n] }),
            },
        } as any;

        // arbitrum chain
        let result = await getQuoteGas(config, orderDetails, multicallAddress);
        assert.equal(result, limitGas + arbitrumL1Gas);

        // other chains
        config.chain.id = 1;
        result = await getQuoteGas(config, orderDetails, multicallAddress);
        assert.equal(result, limitGas);
    });
});
