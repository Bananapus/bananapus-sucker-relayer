import * as dotenv from 'dotenv'
import { CrossChainMessenger, MessageStatus, type CrossChainMessage} from '@eth-optimism/sdk';
import { ethers } from 'ethers';
import { Defender } from '@openzeppelin/defender-sdk';
import type { RelayerTransaction } from '@openzeppelin/defender-sdk-relay-signer-client';

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


async function handleMessages(defender: Defender, xMessenger: CrossChainMessenger, messages: CrossChainMessage[]) {
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
        
            // TODO: Add check to see if we need to execute this message. Ex if we already have a newer (smt) nonce.

            // Perform the action required.
            let tx: ethers.providers.TransactionRequest;
            let state;
            if(status == MessageStatus.READY_TO_PROVE) {
                state = "Proving"
                tx = await xMessenger.populateTransaction.proveMessage(message, undefined, index);
            }else if(status == MessageStatus.READY_FOR_RELAY) {
                state = "Finalization"
                tx =  await xMessenger.populateTransaction.finalizeMessage(message, undefined, index);
            } else {
                continue;
            }

            // Get the pending transactions.
            // We fetch it each time because we want it to be up to date.
            let pendingTxs = await defender.relaySigner.listTransactions({
                status: 'pending',
                usePagination: false
            }) as RelayerTransaction[];

            // Check if the current tx is already pending on the relayer.
            let txAlreadyPending = false;
            for (const index in pendingTxs) {
                const pendingTx: RelayerTransaction = pendingTxs[index];
                
                if(
                    tx.to == pendingTx.to &&
                    tx.data == pendingTx.data
                ){
                    txAlreadyPending = true;
                    break;
                }
            }

            // If it was pending we log and do nothing, 
            // in the future we could want to replace the transaction with one with a higher gas limit.
            if(txAlreadyPending) {
                console.log(`[${new Date().toISOString()}] ${state} of ${type} transaction from block ${message.blockNumber} found in relayer pending queue.`);
                break;
            }
            
            // Send the tx to the relayer.
            await xMessenger.l1Signer.sendTransaction(tx);
            console.log(`[${new Date().toISOString()}] ${state} of ${type} transaction from block ${message.blockNumber} send to relayer 🛫`);

        } catch (error) {
            console.log(`[${new Date().toISOString()}] ❌ Fatal error occured for ${messages[index].transactionHash}`);
            console.error(error);
        }
    }
}


async function checkAllRecentSucks(
    defender: Defender,
    l2Provider: ethers.providers.Provider,
    xMessenger: CrossChainMessenger
) {

    let upToBlock = await l2Provider.getBlockNumber();
    // latestBlock minus a week in seconds divided by 2 second blocks.
    const oldestBlock = upToBlock - (60 * 60 * 24 * 7 / 2); 
    const paginateSize = 500; // 3000;

    let lastLogTxHash;
    while (upToBlock >= oldestBlock) {
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
            await handleMessages(defender, xMessenger, messages);
        }
    }
}


const client = new Defender({
    relayerApiKey: process.env.OZ_DEFENDER_RELAY_API_KEY!,
    relayerApiSecret: process.env.OZ_DEFENDER_RELAY_API_SECRET!,
});

const L2Provider = new ethers.providers.JsonRpcProvider(process.env.L2_RPC_URL!);

// Check if the relayer has been paused.
let status = await client.relaySigner.getRelayerStatus();
if(status.paused) {
    console.error("The OZ Defender relayer has been paused.");
    process.exit(1);
}

const signer = client.relaySigner.getSigner(
    // If there is no custom RPC set we use the one that OZ provides us.
    process.env.L1_RPC_URL ?
        new ethers.providers.JsonRpcProvider(process.env.L1_RPC_URL!):
        client.relaySigner.getProvider(),
    { speed: 'safeLow' }
);

const xMessenger = new CrossChainMessenger({
    l1SignerOrProvider: signer,
    l2SignerOrProvider: L2Provider,
    l1ChainId: parseInt(process.env.L1_CHAIN_ID!),
    l2ChainId: parseInt(process.env.L2_CHAIN_ID!),
    bedrock: true,
});

// 5 minutes between runs.
const timeBetweenRuns = 5 * 60 * 1000;
while(true) {
    console.log(`[${new Date().toISOString()}] Starting a new run 👀`);

    try {
        await checkAllRecentSucks(client, L2Provider, xMessenger);
        console.log(`[${new Date().toISOString()}] Run finished`);
    } catch (error) {
        console.log(`[${new Date().toISOString()}] ❌ Run failed with the following error:`);
        console.error(error);
    }
    
    console.log(`[${new Date().toISOString()}] Waiting ${timeBetweenRuns / 1000 / 60} minutes for the next run...`);
    await Bun.sleep(timeBetweenRuns);
}