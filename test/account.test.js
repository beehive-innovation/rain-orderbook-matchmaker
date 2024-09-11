const { assert } = require("chai");
const { ethers } = require("hardhat");
const { erc20Abi } = require("../src/abis");
const { BridgeUnlimited, ConstantProductRPool } = require("sushi/tines");
const { WNATIVE, WNATIVE_ADDRESS, Native, DAI } = require("sushi/currency");
const { NativeWrapBridgePoolCode, LiquidityProviders, ConstantProductPoolCode } = require("sushi");
const {
    initAccounts,
    manageAccounts,
    withdrawBounty,
    rotateAccounts,
    rotateProviders,
    getBatchEthBalance,
    getBatchTokenBalanceForAccount,
    sweepToEth,
} = require("../src/account");

describe("Test accounts", async function () {
    it("should get batch eth balance", async function () {
        const balances = [10000n, 0n, 0n];
        const viemClient = {
            chain: { id: 137 },
            multicall: async () => balances,
        };
        const result = await getBatchEthBalance([`0x${"0".repeat(64)}`, `0x${"0".repeat(64)}`, `0x${"0".repeat(64)}`], viemClient);
        const expected = balances.map(v => ethers.BigNumber.from(v));
        assert.deepEqual(result, expected);
    });

    it("should get batch token balance for address", async function () {
        const balances = [10000n, 4567n];
        const viemClient = {
            chain: { id: 137 },
            multicall: async () => balances,
        };
        const result = await getBatchTokenBalanceForAccount(`0x${"0".repeat(64)}`, [`0x${"0".repeat(64)}`, `0x${"0".repeat(64)}`], viemClient);
        const expected = balances.map(v => ethers.BigNumber.from(v));
        assert.deepEqual(result, expected);
    });

    it("should withdraw bounty", async function () {
        const viemClient = {
            chain: { id: 137 },
            call: async () => ({ data: 12n }),
        };
        const from = await ethers.getImpersonatedSigner("0xdF906eA18C6537C6379aC83157047F507FB37263");
        await network.provider.send("hardhat_setBalance", [from.address, "0x4563918244F40000"]);
        const token = new ethers.Contract("0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", erc20Abi, from);
        const to = await ethers.getSigner();

        const toOriginalBalance = await token.balanceOf(to.address);
        await withdrawBounty(from, to, token, {}, viemClient);
        const toNewBalance = await token.balanceOf(to.address);

        assert.equal(toNewBalance.sub(12n).toString(), toOriginalBalance.toString());
    });

    it("should initiate accounts successfully with mnemonic", async function () {
        const viemClient = {
            chain: { id: 137 },
            multicall: async () => [10000n, 0n, 0n],
            getGasPrice: async() => 3000000n
        };
        const provider = (await ethers.getSigner()).provider;
        const mnemonic = "test test test test test test test test test test test junk";
        const { mainAccount, accounts } = await initAccounts(mnemonic, provider, "0.0000000000000001", viemClient, 2);

        const expected = [
            {address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"},
            {address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"},
            {address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"},
        ];
        assert.equal(mainAccount.address, expected[0].address);
        assert.equal(accounts[0].address, expected[1].address);
        assert.equal(accounts[1].address, expected[2].address);
    });

    it("should initiate accounts successfully with private key", async function () {
        const viemClient = {
            chain: { id: 137 },
            multicall: async () => [10000n],
        };
        const provider = (await ethers.getSigner()).provider;
        const key = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
        const { mainAccount, accounts } = await initAccounts(key, provider, "100", viemClient, 2);

        const expected = [
            {address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", BALANCE: "10000"},
        ];
        assert.isEmpty(accounts);
        assert.equal(mainAccount.address, expected[0].address);
        assert.equal(mainAccount.BALANCE.toString(), expected[0].BALANCE);
    });

    it("should manage accounts successfully", async function () {
        const viemClient = {
            chain: { id: 137 },
            multicall: async () => [10000n, 0n, 0n],
            getGasPrice: async() => 3000000n
        };
        const mnemonic = "test test test test test test test test test test test junk";

        const [mainAccount] = await ethers.getSigners();
        const acc1 = await ethers.getImpersonatedSigner("0xdF906eA18C6537C6379aC83157047F507FB37263");
        const acc2 = await ethers.getImpersonatedSigner("0xe7804c37c13166fF0b37F5aE0BB07A3aEbb6e245");
        await network.provider.send("hardhat_setBalance", [mainAccount.address, "0x4563918244F40000"]);
        await network.provider.send("hardhat_setBalance", [acc1.address, "0x4563918244F40000"]);
        await network.provider.send("hardhat_setBalance", [acc2.address, "0x4563918244F40000"]);
        acc1.BOUNTY = ["0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"];
        acc2.BOUNTY = ["0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"];
        const provider = acc1.provider;

        mainAccount.BALANCE = ethers.BigNumber.from("0x4563918244F40000");
        acc1.BALANCE = ethers.BigNumber.from("10");
        acc2.BALANCE = ethers.BigNumber.from("0");

        const accounts = [acc1, acc2];
        const result = await manageAccounts(mnemonic, mainAccount, accounts, provider, 20, ethers.BigNumber.from("100"), viemClient, [], []);
        const expectedAccounts = [
            {address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"},
            {address: "0x02484cb50AAC86Eae85610D6f4Bf026f30f6627D"},
            {address: "0x08135Da0A343E492FA2d4282F2AE34c6c5CC1BbE"},
        ];

        assert.equal(result, 22);
        assert.equal(mainAccount.address, expectedAccounts[0].address);
        assert.equal(accounts[0].address, expectedAccounts[1].address);
        assert.equal(accounts[1].address, expectedAccounts[2].address);
    });

    it("should rotate providers", async function () {
        const rpcs = [
            "http://localhost:8080/rpc-url1",
            "http://localhost:8080/rpc-url2"
        ];
        const mainAccount = new ethers.Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
        const accounts = [new ethers.Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d")];
        const config = {
            rpc: rpcs,
            chain: { id: 137 },
            mainAccount,
            accounts,
        };

        rotateProviders(config, mainAccount);

        assert.exists(config.mainAccount);
        assert.exists(config.accounts);
        assert.exists(config.rpc);
        assert.exists(config.provider);
        assert.exists(config.viemClient);
        assert.exists(config.dataFetcher);
        assert.equal(config.chain.id, 137);
        assert.equal(config.viemClient.transport.transports[0].value.url, config.rpc[0]);
        assert.equal(config.viemClient.transport.transports[1].value.url, config.rpc[1]);
        assert.equal(config.mainAccount.provider, config.provider);
        accounts.forEach(v => {
            assert.equal(v.provider, config.provider);
        });
    });

    it("should rotate accounts", async function () {
        const accounts = ["account1", "account2", "account3"];
        rotateAccounts(accounts);

        const expected = ["account2", "account3", "account1"];
        assert.deepEqual(accounts, expected);
    });

    it("should sweep to eth", async function () {
        const { hexlify, randomBytes } = ethers.utils;
        const chainId = 137;
        const native = Native.onChain(chainId);
        const bridge = new BridgeUnlimited(
            WNATIVE_ADDRESS[chainId],
            {
                address: "",
                name: native.name,
                symbol: native.symbol,
                chainId: chainId,
                decimals: 18,
            },
            WNATIVE[chainId],
            0,
            50_000,
        );
        const poolAddress = hexlify(randomBytes(20));
        const fromToken = DAI[chainId];
        const poolCodeMap = new Map([
            [
                poolAddress,
                new ConstantProductPoolCode(
                    new ConstantProductRPool(
                        poolAddress,
                        WNATIVE[chainId],
                        fromToken,
                        0.003,
                        100000000000000000000000n,
                        100000000000000000000000n,
                    ),
                    "QuickSwap",
                    "QuickSwap 0.3%"
                )
            ],
            [
                WNATIVE_ADDRESS[chainId],
                new NativeWrapBridgePoolCode(bridge, LiquidityProviders.NativeWrap),
            ]
        ]);
        const config = {
            chain: { id: chainId },
            mainAccount: {
                BALANCE: ethers.BigNumber.from("10000"),
                BOUNTY: [fromToken],
                address: "0x1F1E4c845183EF6d50E9609F16f6f9cAE43BC9Cb",
                getAddress: () => "0x1F1E4c845183EF6d50E9609F16f6f9cAE43BC9Cb",
                getGasPrice: async () => ethers.BigNumber.from(5),
                estimateGas: async () => ethers.BigNumber.from(25),
                getBalance: async () => ethers.BigNumber.from("10000"),
                sendTransaction: async () => {
                    return {
                        hash: "0x1234",
                        wait: async () => {
                            return {
                                status: 1,
                                effectiveGasPrice: ethers.BigNumber.from(5),
                                gasUsed: ethers.BigNumber.from(10),
                                logs: [],
                                events: [],
                            };
                        }
                    };
                }
            },
            dataFetcher: {
                fetchPoolsForToken: async () => {},
                fetchedPairPools: [],
                web3Client: {
                    getGasPrice: async () => 30_000_000n
                },
                getCurrentPoolCodeMap: () => {
                    return poolCodeMap;
                },
            },
            viemClient: {
                chain: { id: chainId },
                call: async () => ({ data: `0x${"1" + "0".repeat(18)}` }),
            },
        };

        await sweepToEth(config);
        assert.deepEqual(config.mainAccount.BOUNTY, []);
    });
});
