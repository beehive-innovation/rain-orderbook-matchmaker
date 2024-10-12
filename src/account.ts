import { errorSnapshot } from "./error";
import { Span } from "@opentelemetry/api";
import { ChainId, RPParams } from "sushi";
import { BigNumber, ethers } from "ethers";
import { parseAbi, PublicClient } from "viem";
import { Native, Token } from "sushi/currency";
import { getRpSwap, shuffleArray, sleep } from "./utils";
import { ROUTE_PROCESSOR_4_ADDRESS } from "sushi/config";
import { createViemClient, getDataFetcher } from "./config";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { erc20Abi, multicall3Abi, orderbookAbi, routeProcessor3Abi } from "./abis";
import { BotConfig, CliOptions, ViemClient, TokenDetails, OwnedOrder } from "./types";

/** Standard base path for eth accounts */
export const BasePath = "m/44'/60'/0'/0/" as const;

/** Main account derivation index */
export const MainAccountDerivationIndex = 0 as const;

/**
 * Generates array of accounts from mnemonic phrase and tops them up from main acount
 * @param mnemonicOrPrivateKey - The mnemonic phrase or private key
 * @param config - The config obj
 * @param options - The config obj
 * @returns Array of ethers Wallets derived from the given menomonic phrase and standard derivation path
 */
export async function initAccounts(
    mnemonicOrPrivateKey: string,
    config: BotConfig,
    options: CliOptions,
    span?: Span,
) {
    const accounts: ViemClient[] = [];
    const isMnemonic = !/^(0x)?[a-fA-F0-9]{64}$/.test(mnemonicOrPrivateKey);
    const mainAccount = await createViemClient(
        config.chain.id as ChainId,
        config.rpc,
        undefined,
        isMnemonic
            ? mnemonicToAccount(mnemonicOrPrivateKey, { addressIndex: MainAccountDerivationIndex })
            : privateKeyToAccount(
                  (mnemonicOrPrivateKey.startsWith("0x")
                      ? mnemonicOrPrivateKey
                      : "0x" + mnemonicOrPrivateKey) as `0x${string}`,
              ),
        config.timeout,
        (config as any).testClientViem,
    );

    // if the provided key is mnemonic, generate new accounts
    if (isMnemonic) {
        const len = options.walletCount ?? 0;
        for (let addressIndex = 1; addressIndex <= len; addressIndex++) {
            accounts.push(
                await createViemClient(
                    config.chain.id as ChainId,
                    config.rpc,
                    undefined,
                    mnemonicToAccount(mnemonicOrPrivateKey, { addressIndex }),
                    config.timeout,
                    (config as any).testClientViem,
                ),
            );
        }
    }

    // reaed current eth balances of the accounts, this will be
    // tracked on through the bot's process whenever a tx is submitted
    const balances = await getBatchEthBalance(
        [mainAccount.account.address, ...accounts.map((v) => v.account.address)],
        config.viemClient as any as ViemClient,
    );
    mainAccount.BALANCE = balances[0];
    await setWatchedTokens(mainAccount, config.watchedTokens ?? []);

    // incase of excess accounts, top them up from main account
    if (accounts.length) {
        const topupAmountBn = ethers.utils.parseUnits(options.topupAmount!);
        let cumulativeTopupAmount = ethers.constants.Zero;
        for (let i = 1; i < balances.length; i++) {
            if (topupAmountBn.gt(balances[i])) {
                cumulativeTopupAmount = cumulativeTopupAmount.add(topupAmountBn.sub(balances[i]));
            }
        }
        if (cumulativeTopupAmount.gt(balances[0])) {
            throw "low on funds to topup excess wallets with specified initial topup amount";
        } else {
            for (let i = 0; i < accounts.length; i++) {
                await setWatchedTokens(accounts[i], config.watchedTokens ?? []);
                accounts[i].BALANCE = balances[i + 1];

                // only topup those accounts that have lower than expected funds
                const transferAmount = topupAmountBn.sub(balances[i + 1]);
                if (transferAmount.gt(0)) {
                    try {
                        const hash = await mainAccount.sendTransaction({
                            to: accounts[i].account.address,
                            value: transferAmount.toBigInt(),
                        });
                        const receipt = await mainAccount.waitForTransactionReceipt({
                            hash,
                            confirmations: 4,
                            timeout: 100_000,
                        });
                        const txCost = ethers.BigNumber.from(receipt.effectiveGasPrice).mul(
                            receipt.gasUsed,
                        );
                        if (receipt.status === "success") {
                            accounts[i].BALANCE = topupAmountBn;
                            mainAccount.BALANCE =
                                mainAccount.BALANCE.sub(transferAmount).sub(txCost);
                        } else {
                            mainAccount.BALANCE = mainAccount.BALANCE.sub(txCost);
                        }
                    } catch (error) {
                        span?.addEvent(
                            "Startup error, failed to topup wallet: " + errorSnapshot("", error),
                        );
                    }
                }
            }
        }
    }
    return { mainAccount, accounts };
}

/**
 * Manages accounts by removing the ones that are out of gas from circulation
 * and replaces them with new ones while topping them up with x11 of avg gas cost
 * of the arb() transactions, returns the last index used for new wallets.
 * @param config - The config obj
 * @param options - The config obj
 * @param avgGasCost - Avg gas cost of arb txs
 * @param lastIndex - The last index used for wallets
 * @param wgc - wallets garbage collection
 */
export async function manageAccounts(
    config: BotConfig,
    options: CliOptions,
    avgGasCost: BigNumber,
    lastIndex: number,
    wgc: ViemClient[],
    span?: Span,
) {
    let accountsToAdd = 0;
    const gasPrice = await config.viemClient.getGasPrice();
    for (let i = config.accounts.length - 1; i >= 0; i--) {
        if (config.accounts[i].BALANCE.lt(avgGasCost.mul(4))) {
            try {
                await sweepToMainWallet(config.accounts[i], config.mainAccount, gasPrice, span);
            } catch {
                /**/
            }
            // keep in garbage if there are tokens left to sweep
            if (
                config.accounts[i].BOUNTY.length &&
                !wgc.find(
                    (v) =>
                        v.account.address.toLowerCase() ===
                        config.accounts[i].account.address.toLowerCase(),
                )
            ) {
                wgc.unshift(config.accounts[i]);
            }
            accountsToAdd++;
            config.accounts.splice(i, 1);
        }
    }
    if (accountsToAdd > 0) {
        const topupAmountBN = ethers.utils.parseUnits(options.topupAmount!);
        while (accountsToAdd > 0) {
            const acc = await createViemClient(
                config.chain.id as ChainId,
                config.rpc,
                undefined,
                mnemonicToAccount(options.mnemonic!, { addressIndex: ++lastIndex }),
                config.timeout,
                (config as any).testClientViem,
            );
            const balance = ethers.BigNumber.from(
                await acc.getBalance({ address: acc.account.address }),
            );
            acc.BALANCE = balance;
            await setWatchedTokens(acc, config.watchedTokens ?? []);

            if (topupAmountBN.gt(balance)) {
                const transferAmount = topupAmountBN.sub(balance);
                if (config.mainAccount.BALANCE.lt(transferAmount)) {
                    throw `main account lacks suffecient funds to topup new wallets, current balance: ${ethers.utils.formatUnits(
                        config.mainAccount.BALANCE,
                    )}`;
                }
                try {
                    const hash = await config.mainAccount.sendTransaction({
                        to: acc.account.address,
                        value: transferAmount.toBigInt(),
                    });
                    const receipt = await config.mainAccount.waitForTransactionReceipt({
                        hash,
                        confirmations: 4,
                        timeout: 100_000,
                    });
                    const txCost = ethers.BigNumber.from(receipt.effectiveGasPrice).mul(
                        receipt.gasUsed,
                    );
                    if (receipt.status === "success") {
                        acc.BALANCE = topupAmountBN;
                        config.mainAccount.BALANCE =
                            config.mainAccount.BALANCE.sub(transferAmount).sub(txCost);
                        if (
                            !config.accounts.find(
                                (v) =>
                                    v.account.address.toLowerCase() ===
                                    acc.account.address.toLowerCase(),
                            )
                        ) {
                            config.accounts.push(acc);
                        }
                        accountsToAdd--;
                    } else {
                        config.mainAccount.BALANCE = config.mainAccount.BALANCE.sub(txCost);
                    }
                } catch (error) {
                    span?.addEvent("Failed to topup new wallets: " + errorSnapshot("", error));
                }
            } else {
                if (
                    !config.accounts.find(
                        (v) =>
                            v.account.address.toLowerCase() === acc.account.address.toLowerCase(),
                    )
                ) {
                    config.accounts.push(acc);
                }
                accountsToAdd--;
            }
        }
    }
    return lastIndex;
}

/**
 * Rotates the providers rpcs for viem and ethers clients
 * @param config - The config object
 * @param resetDataFetcher
 */
export async function rotateProviders(config: BotConfig, resetDataFetcher = true) {
    if (config.rpc?.length > 1) {
        shuffleArray(config.rpc);
        const viemClient = await createViemClient(
            config.chain.id as ChainId,
            config.rpc,
            false,
            undefined,
            config.timeout,
        );

        if (resetDataFetcher) {
            config.dataFetcher = await getDataFetcher(
                viemClient as any as PublicClient,
                config.lps,
                false,
            );
        } else {
            config.dataFetcher.web3Client = viemClient as any as PublicClient;
        }
        config.viemClient = viemClient as any as PublicClient;

        // rotate main account's provider
        const mainAccBalance = config.mainAccount.BALANCE;
        const mainAccBounty = config.mainAccount.BOUNTY;
        const mainAcc = await createViemClient(
            config.chain.id as ChainId,
            config.rpc,
            false,
            config.mainAccount.account,
            config.timeout,
        );
        // config.mainAccount.connect(provider);
        mainAcc.BALANCE = mainAccBalance;
        mainAcc.BOUNTY = mainAccBounty;
        config.mainAccount = mainAcc;

        // rotate other accounts' provider
        for (let i = 0; i < config.accounts.length; i++) {
            const balance = config.accounts[i].BALANCE;
            const bounty = config.accounts[i].BOUNTY;
            const acc = await createViemClient(
                config.chain.id as ChainId,
                config.rpc,
                false,
                config.accounts[i].account,
                config.timeout,
            );
            acc.BALANCE = balance;
            acc.BOUNTY = bounty;
            config.accounts[i] = acc;
        }
    } else {
        if (resetDataFetcher) {
            config.dataFetcher = await getDataFetcher(config.viemClient, config.lps, false);
        }
    }
}

/**
 * Rotates accounts by putting the first one in last place
 * @param accounts - Array of accounts to rotate
 */
export function rotateAccounts(accounts: ViemClient[]) {
    if (accounts && Array.isArray(accounts) && accounts.length > 1) {
        accounts.push(accounts.shift()!);
    }
}

/**
 * Get eth balance of multiple accounts using multicall
 * @param addresses - The addresses to get their balance
 * @param viemClient - The viem client
 * @param multicallAddressOverride - Override multicall3 address
 */
export async function getBatchEthBalance(
    addresses: string[],
    viemClient: ViemClient,
    multicallAddressOverride?: string,
) {
    return (
        await viemClient.multicall({
            multicallAddress: (multicallAddressOverride ??
                viemClient.chain?.contracts?.multicall3?.address) as `0x${string}`,
            allowFailure: false,
            contracts: addresses.map((v) => ({
                address: (multicallAddressOverride ??
                    viemClient.chain?.contracts?.multicall3?.address) as `0x${string}`,
                allowFailure: false,
                chainId: viemClient.chain.id,
                abi: parseAbi(multicall3Abi),
                functionName: "getEthBalance",
                args: [v],
            })),
        })
    ).map((v) => ethers.BigNumber.from(v));
}

/**
 * Get balance of multiple erc20 tokens for an account using multicall3
 * @param address - The address to get its token balances
 * @param tokens - The token addresses to get their balance
 * @param viemClient - The viem client
 * @param multicallAddressOverride - Override multicall3 address
 */
export async function getBatchTokenBalanceForAccount(
    address: string,
    tokens: TokenDetails[],
    viemClient: ViemClient,
    multicallAddressOverride?: string,
) {
    return (
        await viemClient.multicall({
            multicallAddress: (multicallAddressOverride ??
                viemClient.chain?.contracts?.multicall3?.address) as `0x${string}`,
            allowFailure: false,
            contracts: tokens.map((v) => ({
                address: v.address as `0x${string}`,
                allowFailure: false,
                chainId: viemClient.chain.id,
                abi: parseAbi(erc20Abi),
                functionName: "balanceOf",
                args: [address],
            })),
        })
    ).map((v) => ethers.BigNumber.from(v));
}

/**
 * Sweep bot's bounties
 * @param fromWallet - The from wallet
 * @param toWallet - The to wallet
 * @param gasPrice - Gas price
 */
export async function sweepToMainWallet(
    fromWallet: ViemClient,
    toWallet: ViemClient,
    gasPrice: bigint,
    span?: Span,
) {
    gasPrice = ethers.BigNumber.from(gasPrice).mul(107).div(100).toBigInt();
    const erc20 = new ethers.utils.Interface(erc20Abi);
    const txs: {
        bounty: TokenDetails;
        tx: {
            to: `0x${string}`;
            data: `0x${string}`;
        };
    }[] = [];
    const failedBounties: TokenDetails[] = [];
    let cumulativeGasLimit = ethers.constants.Zero;
    for (let i = 0; i < fromWallet.BOUNTY.length; i++) {
        const bounty = fromWallet.BOUNTY[i];
        try {
            const balance = ethers.BigNumber.from(
                (
                    await fromWallet.call({
                        to: bounty.address as `0x${string}`,
                        data: erc20.encodeFunctionData("balanceOf", [
                            fromWallet.account.address,
                        ]) as `0x${string}`,
                    })
                ).data,
            );
            if (balance.isZero()) {
                continue;
            }
            const tx = {
                to: bounty.address as `0x${string}`,
                data: erc20.encodeFunctionData("transfer", [
                    toWallet.account.address,
                    balance,
                ]) as `0x${string}`,
            };
            txs.push({ tx, bounty });
            const gas = await fromWallet.estimateGas(tx);
            cumulativeGasLimit = cumulativeGasLimit.add(gas);
        } catch {
            failedBounties.push(bounty);
        }
    }

    if (cumulativeGasLimit.mul(gasPrice).gt(fromWallet.BALANCE)) {
        try {
            const transferAmount = cumulativeGasLimit.mul(gasPrice).sub(fromWallet.BALANCE);
            const hash = await toWallet.sendTransaction({
                to: fromWallet.account.address,
                value: transferAmount.toBigInt(),
            });
            const receipt = await toWallet.waitForTransactionReceipt({
                hash,
                confirmations: 2,
                timeout: 100_000,
            });
            const txCost = ethers.BigNumber.from(receipt.effectiveGasPrice).mul(receipt.gasUsed);
            if (receipt.status === "success") {
                fromWallet.BALANCE = fromWallet.BALANCE.add(transferAmount);
                toWallet.BALANCE = toWallet.BALANCE.sub(transferAmount).sub(txCost);
            } else {
                toWallet.BALANCE = toWallet.BALANCE.sub(txCost);
            }
        } catch (error) {
            span?.addEvent(
                "Failed topping up wallet for sweeping tokens back to main wallet: " +
                    errorSnapshot("", error),
            );
        }
    }

    for (let i = 0; i < txs.length; i++) {
        try {
            const hash = await fromWallet.sendTransaction(txs[i].tx);
            const receipt = await fromWallet.waitForTransactionReceipt({
                hash,
                confirmations: 2,
                timeout: 100_000,
            });
            const txCost = ethers.BigNumber.from(receipt.effectiveGasPrice).mul(receipt.gasUsed);
            if (receipt.status === "success") {
                if (!toWallet.BOUNTY.find((v) => v.address === txs[i].bounty.address)) {
                    toWallet.BOUNTY.push(txs[i].bounty);
                }
                span?.addEvent(`Successfully swept ${txs[i].bounty.symbol} back to main wallet`);
            } else {
                failedBounties.push(txs[i].bounty);
            }
            fromWallet.BALANCE = fromWallet.BALANCE.sub(txCost);
        } catch (error) {
            span?.addEvent(
                `Failed to sweep ${txs[i].bounty.symbol} back to main wallet: ` +
                    errorSnapshot("", error),
            );
            failedBounties.push(txs[i].bounty);
        }
    }

    // empty gas if all tokens are swept
    if (!failedBounties.length) {
        try {
            const gasLimit = ethers.BigNumber.from(
                await fromWallet.estimateGas({
                    to: toWallet.account.address,
                    value: 0n,
                }),
            );
            const remainingGas = ethers.BigNumber.from(
                await fromWallet.getBalance({ address: fromWallet.account.address }),
            );
            const transferAmount = remainingGas.sub(gasLimit.mul(gasPrice));
            if (transferAmount.gt(0)) {
                const hash = await fromWallet.sendTransaction({
                    to: toWallet.account.address,
                    value: transferAmount.toBigInt(),
                    gas: gasLimit.toBigInt(),
                });
                const receipt = await fromWallet.waitForTransactionReceipt({
                    hash,
                    confirmations: 2,
                    timeout: 100_000,
                });
                const txCost = ethers.BigNumber.from(receipt.effectiveGasPrice).mul(
                    receipt.gasUsed,
                );
                if (receipt.status === "success") {
                    toWallet.BALANCE = toWallet.BALANCE.add(transferAmount);
                    fromWallet.BALANCE = fromWallet.BALANCE.sub(txCost).sub(transferAmount);
                } else {
                    fromWallet.BALANCE = fromWallet.BALANCE.sub(txCost);
                }
            }
        } catch (error) {
            span?.addEvent(
                "Failed to sweep gas tokens back to main wallet: " + errorSnapshot("", error),
            );
        }
    }
    fromWallet.BOUNTY = failedBounties;
}

/**
 * Sweep bot's bounties to eth
 * @param config - The config obj
 */
export async function sweepToEth(config: BotConfig, span?: Span) {
    const skipped: TokenDetails[] = [];
    const rp4Address = ROUTE_PROCESSOR_4_ADDRESS[
        config.chain.id as keyof typeof ROUTE_PROCESSOR_4_ADDRESS
    ] as `0x${string}`;
    const rp = new ethers.utils.Interface(routeProcessor3Abi);
    const erc20 = new ethers.utils.Interface(erc20Abi);
    const gasPrice = ethers.BigNumber.from(await config.mainAccount.getGasPrice())
        .mul(107)
        .div(100);
    for (let i = 0; i < config.mainAccount.BOUNTY.length; i++) {
        const bounty = config.mainAccount.BOUNTY[i];
        try {
            const balance = ethers.BigNumber.from(
                (
                    await config.viemClient.call({
                        to: bounty.address as `0x${string}`,
                        data: erc20.encodeFunctionData("balanceOf", [
                            config.mainAccount.account.address,
                        ]) as `0x${string}`,
                    })
                ).data,
            );
            if (balance.isZero()) {
                continue;
            }
            const token = new Token({
                chainId: config.chain.id,
                decimals: bounty.decimals,
                address: bounty.address,
                symbol: bounty.symbol,
            });
            const { rpParams } = await getRpSwap(
                config.chain.id,
                balance,
                token,
                Native.onChain(config.chain.id),
                config.mainAccount.account.address,
                rp4Address,
                config.dataFetcher,
                gasPrice,
            );
            const amountOutMin = ethers.BigNumber.from(rpParams.amountOutMin);
            const data = rp.encodeFunctionData("processRoute", [
                rpParams.tokenIn,
                rpParams.amountIn,
                rpParams.tokenOut,
                rpParams.amountOutMin,
                rpParams.to,
                rpParams.routeCode,
            ]) as `0x${string}`;
            const allowance = (
                await config.viemClient.call({
                    to: bounty.address as `0x${string}`,
                    data: erc20.encodeFunctionData("allowance", [
                        config.mainAccount.account.address,
                        rp4Address,
                    ]) as `0x${string}`,
                })
            ).data;
            if (allowance && balance.gt(allowance)) {
                const hash = await config.mainAccount.sendTransaction({
                    to: bounty.address as `0x${string}`,
                    data: erc20.encodeFunctionData("approve", [
                        rp4Address,
                        balance.mul(100),
                    ]) as `0x${string}`,
                });
                await config.mainAccount.waitForTransactionReceipt({
                    hash,
                    confirmations: 2,
                    timeout: 100_000,
                });
            }
            const rawtx = { to: rp4Address, data };
            const gas = await config.mainAccount.estimateGas(rawtx);
            const gasCost = gasPrice.mul(gas).mul(15).div(10);
            if (gasCost.mul(25).gte(amountOutMin)) {
                skipped.push(bounty);
                continue;
            } else {
                (rawtx as any).gas = gas;
                const hash = await config.mainAccount.sendTransaction(rawtx);
                const receipt = await config.mainAccount.waitForTransactionReceipt({
                    hash,
                    confirmations: 2,
                    timeout: 100_000,
                });
                if (receipt.status === "success") {
                    span?.addEvent(`Successfully swept ${bounty.symbol} to eth`);
                }
            }
        } catch (e) {
            skipped.push(bounty);
            span?.addEvent(`Failed to sweep ${bounty.symbol} to eth: ` + errorSnapshot("", e));
        }
        await sleep(10000);
    }
    config.mainAccount.BOUNTY = skipped;
    for (let i = 0; i < 20; i++) {
        try {
            config.mainAccount.BALANCE = ethers.BigNumber.from(
                await config.mainAccount.getBalance({
                    address: config.mainAccount.account.address,
                }),
            );
            return;
        } catch {
            if (i != 19) await sleep(10000 * (i + 1));
        }
    }
}

export async function setWatchedTokens(account: ViemClient, watchedTokens: TokenDetails[]) {
    account.BOUNTY = watchedTokens;
}

/**
 * Funds the sepcified bot owned orders from the gas token
 * @param ownedOrders
 * @param config
 */
export async function fundOwnedOrders(
    ownedOrders: OwnedOrder[],
    config: BotConfig,
): Promise<{ ownedOrder?: OwnedOrder; error: string }[]> {
    const failedFundings: { ownedOrder?: OwnedOrder; error: string }[] = [];
    const ob = new ethers.utils.Interface(orderbookAbi);
    const erc20 = new ethers.utils.Interface(erc20Abi);
    const rp = new ethers.utils.Interface(routeProcessor3Abi);
    const rp4Address =
        ROUTE_PROCESSOR_4_ADDRESS[config.chain.id as keyof typeof ROUTE_PROCESSOR_4_ADDRESS];
    let gasPrice: BigNumber;
    for (let i = 0; i < 4; i++) {
        try {
            gasPrice = ethers.BigNumber.from(await config.viemClient.getGasPrice())
                .mul(107)
                .div(100);
            break;
        } catch (e) {
            if (i == 3)
                return [
                    {
                        error: errorSnapshot("failed to get gas price", e),
                    },
                ];
            else await sleep(10000 * (i + 1));
        }
    }
    if (config.selfFundOrders) {
        for (let i = 0; i < ownedOrders.length; i++) {
            const ownedOrder = ownedOrders[i];
            const vaultId = ethers.BigNumber.from(ownedOrder.vaultId);
            const fundingOrder = config.selfFundOrders.find(
                (e) =>
                    e.token.toLowerCase() === ownedOrder.token.toLowerCase() &&
                    vaultId.eq(e.vaultId),
            );
            if (fundingOrder) {
                if (
                    ownedOrder.vaultBalance.lt(
                        ethers.utils.parseUnits(fundingOrder.threshold, ownedOrder.decimals),
                    )
                ) {
                    const topupAmount = ethers.utils.parseUnits(
                        fundingOrder.topupAmount,
                        ownedOrder.decimals,
                    );
                    try {
                        const balance = (
                            await config.mainAccount.call({
                                to: ownedOrder.token as `0x${string}`,
                                data: erc20.encodeFunctionData("balanceOf", [
                                    config.mainAccount.account.address,
                                ]) as `0x${string}`,
                            })
                        ).data;
                        if (balance && topupAmount.gt(balance)) {
                            const token = new Token({
                                chainId: config.chain.id,
                                decimals: ownedOrder.decimals,
                                address: ownedOrder.token,
                                symbol: ownedOrder.symbol,
                            });
                            const { route } = await getRpSwap(
                                config.chain.id,
                                topupAmount,
                                token,
                                Native.onChain(config.chain.id),
                                config.mainAccount.account.address,
                                rp4Address,
                                config.dataFetcher,
                                gasPrice!,
                            );
                            const initSellAmount = ethers.BigNumber.from(route.amountOutBI);
                            let sellAmount: BigNumber;
                            let finalRpParams: RPParams;
                            for (let j = 0; j < 25; j++) {
                                sellAmount = initSellAmount.mul(100 + j).div(100);
                                const { rpParams, route } = await getRpSwap(
                                    config.chain.id,
                                    sellAmount,
                                    Native.onChain(config.chain.id),
                                    token,
                                    config.mainAccount.account.address,
                                    rp4Address,
                                    config.dataFetcher,
                                    gasPrice!,
                                );
                                if (topupAmount.lte(route.amountOutBI)) {
                                    finalRpParams = rpParams;
                                    break;
                                }
                            }
                            const data = rp.encodeFunctionData("processRoute", [
                                finalRpParams!.tokenIn,
                                finalRpParams!.amountIn,
                                finalRpParams!.tokenOut,
                                finalRpParams!.amountOutMin,
                                finalRpParams!.to,
                                finalRpParams!.routeCode,
                            ]) as `0x${string}`;
                            const swapHash = await config.mainAccount.sendTransaction({
                                to: rp4Address,
                                value: sellAmount!.toBigInt(),
                                data,
                            });
                            const swapReceipt = await config.mainAccount.waitForTransactionReceipt({
                                hash: swapHash,
                                confirmations: 2,
                                timeout: 100_000,
                            });
                            const swapTxCost = ethers.BigNumber.from(
                                swapReceipt.effectiveGasPrice,
                            ).mul(swapReceipt.gasUsed);
                            config.mainAccount.BALANCE = config.mainAccount.BALANCE.sub(swapTxCost);
                            if (swapReceipt.status === "success") {
                                config.mainAccount.BALANCE = config.mainAccount.BALANCE.sub(
                                    sellAmount!,
                                );
                            } else {
                                throw "failed to swap eth to vault token";
                            }
                        }

                        const allowance = (
                            await config.mainAccount.call({
                                to: ownedOrder.token as `0x${string}`,
                                data: erc20.encodeFunctionData("allowance", [
                                    config.mainAccount.account.address,
                                    ownedOrder.orderbook,
                                ]) as `0x${string}`,
                            })
                        ).data;
                        if (allowance && topupAmount.gt(allowance)) {
                            const approveHash = await config.mainAccount.sendTransaction({
                                to: ownedOrder.token as `0x${string}`,
                                data: erc20.encodeFunctionData("approve", [
                                    ownedOrder.orderbook,
                                    topupAmount.mul(20),
                                ]) as `0x${string}`,
                            });
                            const approveReceipt =
                                await config.mainAccount.waitForTransactionReceipt({
                                    hash: approveHash,
                                    confirmations: 2,
                                    timeout: 100_000,
                                });
                            const approveTxCost = ethers.BigNumber.from(
                                approveReceipt.effectiveGasPrice,
                            ).mul(approveReceipt.gasUsed);
                            config.mainAccount.BALANCE =
                                config.mainAccount.BALANCE.sub(approveTxCost);
                            if (approveReceipt.status === "reverted") {
                                throw "failed to approve token spend";
                            }
                        }

                        const hash = await config.mainAccount.sendTransaction({
                            to: ownedOrder.orderbook as `0x${string}`,
                            data: ob.encodeFunctionData("deposit2", [
                                ownedOrder.token,
                                vaultId,
                                topupAmount,
                                [],
                            ]) as `0x${string}`,
                        });
                        const receipt = await config.mainAccount.waitForTransactionReceipt({
                            hash,
                            confirmations: 2,
                            timeout: 100_000,
                        });
                        const txCost = ethers.BigNumber.from(receipt.effectiveGasPrice).mul(
                            receipt.gasUsed,
                        );
                        config.mainAccount.BALANCE = config.mainAccount.BALANCE.sub(txCost);
                        if (receipt.status === "success") {
                            ownedOrder.vaultBalance = ownedOrder.vaultBalance.add(topupAmount);
                        }
                    } catch (error) {
                        failedFundings.push({
                            ownedOrder,
                            error: errorSnapshot("Failed to fund owned vault", error),
                        });
                    }
                }
            }
        }
    }
    return failedFundings;
}
