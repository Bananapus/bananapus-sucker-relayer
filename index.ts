import * as dotenv from 'dotenv'
import { CrossChainMessenger, MessageStatus, type CrossChainMessage, type ProviderLike } from '@eth-optimism/sdk';
import { ethers } from 'ethers';

// Load the env file.
dotenv.config()

enum MessageType {
    DO_NOT_EXECUTE,
    MESSAGE,
    VALUE
}

function getMessageType(message: CrossChainMessage, l1suckerAddr: string, l2suckerAddr: string, standardBridge: string): MessageType {
    l1suckerAddr = ethers.utils.getAddress(l1suckerAddr);
    l2suckerAddr = ethers.utils.getAddress(l2suckerAddr);
    standardBridge = ethers.utils.getAddress(standardBridge);

    let coder = new ethers.utils.AbiCoder();

    // Check if this is an ERC20 transfer.
    if(ethers.utils.getAddress(message.target) == standardBridge) {
        // Decode `finalizeBridgeERC20`
        let decoded = coder.decode(
            ['address', 'address', 'address', 'address', 'uint256', 'bytes'],
            ethers.utils.hexDataSlice(message.message, 4)
        );

        // TODO: If we want to entirely stop potential griefing attacks we can do one (or multiple) of the following:
        // - Check that the ERC20 transfer falls within requirements (is it more than the configured minAmount, is the token configured etc.)
        // - Check the call trace to see which one were done by the contract
        // - Emit an event in the sucker to show which ones are valid

        if(ethers.utils.getAddress(decoded[3]) == l1suckerAddr) return MessageType.VALUE;
    }

    // Check if this is an SMT transfer.
    if(ethers.utils.getAddress(message.sender) == l2suckerAddr && ethers.utils.getAddress(message.target) == l1suckerAddr) {
        // If the value is zero this is just a message, which is not as important. 
        return message.value.isZero() ? MessageType.MESSAGE : MessageType.VALUE;
    }

    return MessageType.DO_NOT_EXECUTE;
}


async function handleMessages(xMessenger: CrossChainMessenger, messages: CrossChainMessage[]) {
    console.log(`found ${messages.length} messages`);

    // For loop over messages
    for (let index = 0; index < messages.length; index++) {
        try {
            const message = messages[index];
        
            let status = await xMessenger.getMessageStatus(message, index);
            let priority = getMessageType(
                message,
                process.env.L1_SUCKER_ADDRESS!,
                process.env.L2_SUCKER_ADDRESS!,
                process.env.L1_STANDARD_BRIDGE_ADDRESS!
            );
        
            // Ensure transactions have to do with the project.
            if(priority == MessageType.DO_NOT_EXECUTE) continue;

            let type = priority == MessageType.VALUE ? "value-message" : "root-message";
        
            // TODO: Add check to see if we need to execute this message. Ex if we already have a newer nonce.
        
            // Perform the action required.
            let tx: ethers.providers.TransactionResponse;
            if(status == MessageStatus.READY_TO_PROVE) {
                console.log(`Proving ${type} from ${message.blockNumber}`);
                tx = await xMessenger.proveMessage(message, undefined, index);
            }else if(status == MessageStatus.READY_FOR_RELAY) {
                console.log(`Finalizing ${type} from ${message.blockNumber}`);
                tx = await xMessenger.finalizeMessage(message, undefined, index);
            } else {
                continue;
            }
            
            console.log("Waiting for 3 blocks of confirmation...");
            let receipt = await tx.wait(3);
            console.log("Confirmations done!");

        } catch (error) {
            console.error(error);
            console.log("Skipping this transaction because of an error..");
        }
    }
}


async function checkAllRecentSucks(
    l2Provider: ethers.providers.Provider,
    xMessenger: CrossChainMessenger
) {

    let upToBlock = await l2Provider.getBlockNumber();
    // latestBlock minus a week in seconds divided by 2 second blocks.
    // const oldestBlock = upToBlock - (60 * 60 * 24 * 7 / 2); 
    const oldestBlock = upToBlock - 10_000;
    const paginateSize = 100;

    let lastLogTxHash;
    while (upToBlock >= oldestBlock) {
        console.log(`looking in blocks ${upToBlock - paginateSize} - ${upToBlock}`);
        const filter = {
            address: process.env.L2_SUCKER_ADDRESS!,
            topics: [
                // the name of the event, parnetheses containing the data type of each event, no spaces
                ethers.utils.id("SuckingToRemote(address,uint64)")
            ],
            fromBlock: upToBlock - paginateSize,
            toBlock: upToBlock
        }

        upToBlock -= paginateSize;
        
        // Get the events.
        let logs = await l2Provider.getLogs(filter);
        
        for (const index in logs) {
            const log = logs[index];

            // Prevent checking all the messages from a transaction twice.
            if(log.transactionHash == lastLogTxHash) continue;
            lastLogTxHash = log.transactionHash;

            const messages = await xMessenger.getMessagesByTransaction(
                log.transactionHash
            );

            // Check if the messages require work to be done and perform work if needed.
            await handleMessages(xMessenger, messages);
        }
    }
}

const L1Provider = new ethers.providers.JsonRpcProvider(process.env.L1_RPC_URL!);
const L2Provider = new ethers.providers.JsonRpcProvider(process.env.L2_RPC_URL!);
const l1Signer = new ethers.Wallet(process.env.EOA_PRIVATE_KEY!, L1Provider);

const xMessenger = new CrossChainMessenger({
    l1SignerOrProvider: l1Signer,
    l2SignerOrProvider: L2Provider,
    l1ChainId: parseInt(process.env.L1_CHAIN_ID!),
    l2ChainId: parseInt(process.env.L2_CHAIN_ID!),
    bedrock: true,
});

await checkAllRecentSucks(L2Provider, xMessenger);