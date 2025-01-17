// import fs from "fs";
// import { deployerAbi } from "./abis";
import {
    BigNumber,
    // utils
} from "ethers";
// import { Dispair, ViemClient } from "./types";
// import { parseAbi, PublicClient, stringToHex } from "viem";
// import { MetaStore, RainDocument } from "@rainlanguage/dotrain";

// export const TaskEntryPoint = ["main"] as const;
// export const EnsureBountyDotrain = fs.readFileSync("./tasks/ensure-bounty.rain", {
//     encoding: "utf8",
// });
// export const WithdrawEnsureBountyDotrain = fs.readFileSync("./tasks/withdraw-ensure-bounty.rain", {
//     encoding: "utf8",
// });

// /**
//  * Get the bounty check ensure task rainlang
//  * @param inputToEthPrice - Input token to Eth price
//  * @param outputToEthPrice - Output token to Eth price
//  * @param minimumExpected - Minimum expected amount
//  * @param sender - The msg sender
//  */
// export async function getBountyEnsureRainlang(
//     inputToEthPrice: BigNumber,
//     outputToEthPrice: BigNumber,
//     minimumExpected: BigNumber,
//     sender: string,
// ): Promise<string> {
//     return await RainDocument.composeText(
//         EnsureBountyDotrain,
//         TaskEntryPoint as any as string[],
//         new MetaStore(),
//         [
//             ["sender", sender],
//             ["input-to-eth-price", utils.formatUnits(inputToEthPrice)],
//             ["output-to-eth-price", utils.formatUnits(outputToEthPrice)],
//             ["minimum-expected", utils.formatUnits(minimumExpected)],
//         ],
//     );
// }

// /**
//  * Get the bounty check ensure task rainlang for clear2 withdraw
//  * @param botAddress - Bot wallet address
//  * @param inputToken - Input token address
//  * @param outputToken - Output token address
//  * @param orgInputBalance - Input token original balance
//  * @param orgOutputBalance - Output token original balance
//  * @param inputToEthPrice - Input token to Eth price
//  * @param outputToEthPrice - Output token to Eth price
//  * @param minimumExpected - Minimum expected amount
//  * @param sender - The msg sender
//  */
// export async function getWithdrawEnsureRainlang(
//     botAddress: string,
//     inputToken: string,
//     outputToken: string,
//     orgInputBalance: BigNumber,
//     orgOutputBalance: BigNumber,
//     inputToEthPrice: BigNumber,
//     outputToEthPrice: BigNumber,
//     minimumExpected: BigNumber,
//     sender: string,
// ): Promise<string> {
//     return await RainDocument.composeText(
//         WithdrawEnsureBountyDotrain,
//         TaskEntryPoint as any as string[],
//         new MetaStore(),
//         [
//             ["sender", sender],
//             ["bot-address", botAddress],
//             ["input-token", inputToken],
//             ["output-token", outputToken],
//             ["minimum-expected", utils.formatUnits(minimumExpected)],
//             ["input-to-eth-price", utils.formatUnits(inputToEthPrice)],
//             ["output-to-eth-price", utils.formatUnits(outputToEthPrice)],
//             ["org-input-balance", utils.formatUnits(orgInputBalance)],
//             ["org-output-balance", utils.formatUnits(orgOutputBalance)],
//         ],
//     );
// }

// /**
//  * Calls parse2 on a given deployer to parse the given rainlang text
//  */
// export async function parseRainlang(
//     rainlang: string,
//     viemClient: ViemClient | PublicClient,
//     dispair: Dispair,
// ): Promise<string> {
//     return await viemClient.readContract({
//         address: dispair.deployer as `0x${string}`,
//         abi: parseAbi(deployerAbi),
//         functionName: "parse2",
//         args: [stringToHex(rainlang)],
//     });
// }

/**
 * Get the bounty check ensure task bytecode
 * @param inputToEthPrice - Input token to Eth price
 * @param outputToEthPrice - Output token to Eth price
 * @param minimumExcepted - Minimum expected amount
 */
export function getBountyEnsureBytecode(
    inputToEthPrice: BigNumber,
    outputToEthPrice: BigNumber,
    minimumExcepted: BigNumber,
    sender: string,
): string {
    const inputPrice = inputToEthPrice.toHexString().substring(2).padStart(64, "0");
    const outputPrice = outputToEthPrice.toHexString().substring(2).padStart(64, "0");
    const minimum = minimumExcepted.toHexString().substring(2).padStart(64, "0");
    const msgSender = sender.substring(2).padStart(64, "0").toLowerCase();
    // rainlang bytecode:
    // :ensure(equal-to(sender context<0 0>()) \"unknown sender\"),
    // :ensure(
    //   greater-than-or-equal-to(
    //     add(
    //       mul(inputToEthPrice context<1 0>())
    //       mul(outputToEthPrice context<1 1>())
    //     )
    //     minimumExcepted
    //   )
    //   \"minimum sender output\"
    // );
    return `0x0000000000000000000000000000000000000000000000000000000000000006${msgSender}8e756e6b6e6f776e2073656e6465720000000000000000000000000000000000${inputPrice}${outputPrice}${minimum}956d696e696d756d2073656e646572206f7574707574000000000000000000000000000000000000000000000000000000000000000000000000000000000047010000100500000110000103100000011000001e1200001d020000011000050110000403100101011000033d12000003100001011000023d1200002b120000211200001d020000`;
}

/**
 * Get the bounty check ensure task bytecode for clear2 withdraw
 * @param botAddress - Bot wallet address
 * @param inputToken - Input token address
 * @param outputToken - Output token address
 * @param orgInputBalance - Input token original balance
 * @param orgOutputBalance - Output token original balance
 * @param inputToEthPrice - Input token to Eth price
 * @param outputToEthPrice - Output token to Eth price
 * @param minimumExcepted - Minimum expected amount
 */
export function getWithdrawEnsureBytecode(
    botAddress: string,
    inputToken: string,
    outputToken: string,
    orgInputBalance: BigNumber,
    orgOutputBalance: BigNumber,
    inputToEthPrice: BigNumber,
    outputToEthPrice: BigNumber,
    minimumExcepted: BigNumber,
    sender: string,
): string {
    const bot = botAddress.substring(2).padStart(64, "0");
    const input = inputToken.substring(2).padStart(64, "0");
    const output = outputToken.substring(2).padStart(64, "0");
    const inputBalance = orgInputBalance.toHexString().substring(2).padStart(64, "0");
    const outputBalance = orgOutputBalance.toHexString().substring(2).padStart(64, "0");
    const inputPrice = inputToEthPrice.toHexString().substring(2).padStart(64, "0");
    const outputPrice = outputToEthPrice.toHexString().substring(2).padStart(64, "0");
    const minimum = minimumExcepted.toHexString().substring(2).padStart(64, "0");
    const msgSender = sender.substring(2).padStart(64, "0").toLowerCase();
    // rainlang bytecode:
    // :ensure(equal-to(sender context<0 0>()) \"unknown sender\"),
    // :ensure(
    //   greater-than-or-equal-to(
    //     add(
    //       mul(sub(erc20-balance-of(inputToken botAddress) originalInputBalance) inputToEthPrice)
    //       mul(sub(erc20-balance-of(outputToken botAddress) originalOutputBalance) outputToEthPrice)
    //     )
    //     minimumSenderOutput
    //   )
    //   \"minimumSenderOutput\"
    // );
    return `0x000000000000000000000000000000000000000000000000000000000000000b${msgSender}8e756e6b6e6f776e2073656e6465720000000000000000000000000000000000${input}${bot}${inputBalance}${inputPrice}${output}${outputBalance}${outputPrice}${minimum}936d696e696d756d53656e6465724f75747075740000000000000000000000000000000000000000000000000000000000000000000000000000000000000067010000180700000110000103100000011000001e1200001d0200000110000a011000090110000801100007011000030110000611120000471200003d1200000110000501100004011000030110000211120000471200003d1200002b120000211200001d020000`;
}
