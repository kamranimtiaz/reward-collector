import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import * as anchor from '@coral-xyz/anchor';
import type { Idl } from '@coral-xyz/anchor';
import {
  Commitment,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { OnlinePumpSdk } from '@pump-fun/pump-sdk';
import {
  AccountLayout,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID
} from '@solana/spl-token';

const commitment: Commitment = 'confirmed';

const RPC_URL =
  process.env.SOLANA_RPC_URL ??
  process.env.SOLANA_MAINNET_RPC_URL ??
  process.env.SOLANA_DEVNET_RPC_URL;

if (!RPC_URL) {
  throw new Error('Set SOLANA_RPC_URL (or SOLANA_MAINNET_RPC_URL / SOLANA_DEVNET_RPC_URL).');
}

const TOKEN_MINT = process.env.TOKEN_MINT;
if (!TOKEN_MINT) {
  throw new Error('Set TOKEN_MINT to the token mint address.');
}

// Load developer keypair from environment variable or file
let developerKeypair: Keypair;
const developerPrivateKeyEnv = process.env.PUMPFUN_DEVELOPER_PRIVATE_KEY;

if (developerPrivateKeyEnv) {
  // Parse from environment variable (comma-separated or JSON array)
  try {
    const secretKey = developerPrivateKeyEnv.startsWith('[')
      ? JSON.parse(developerPrivateKeyEnv)
      : developerPrivateKeyEnv.split(',').map(num => parseInt(num.trim(), 10));
    developerKeypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));
  } catch (error) {
    throw new Error(
      'Failed to parse PUMPFUN_DEVELOPER_PRIVATE_KEY. Ensure it is a JSON array or comma-separated numbers.',
    );
  }
} else {
  // Fallback to file path
  const developerKeypairPathRaw = process.env.PUMPFUN_DEVELOPER_KEYPAIR ?? './keys/pump-developer.json';
  const developerKeypairPath = path.resolve(process.cwd(), developerKeypairPathRaw);
  if (!fs.existsSync(developerKeypairPath)) {
    throw new Error(
      `Developer keypair not found. Set PUMPFUN_DEVELOPER_PRIVATE_KEY (private key as JSON array) or PUMPFUN_DEVELOPER_KEYPAIR (path to keypair file).`,
    );
  }
  developerKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(developerKeypairPath, 'utf8'))),
  );
}

const developerPubkey = developerKeypair.publicKey;

// Load pool owner keypair from environment variable or file
let ownerKeypair: Keypair;
const ownerPrivateKeyEnv = process.env.POOL_OWNER_PRIVATE_KEY;

if (ownerPrivateKeyEnv) {
  // Parse from environment variable (comma-separated or JSON array)
  try {
    const secretKey = ownerPrivateKeyEnv.startsWith('[')
      ? JSON.parse(ownerPrivateKeyEnv)
      : ownerPrivateKeyEnv.split(',').map(num => parseInt(num.trim(), 10));
    ownerKeypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));
  } catch (error) {
    throw new Error(
      'Failed to parse POOL_OWNER_PRIVATE_KEY. Ensure it is a JSON array or comma-separated numbers.',
    );
  }
} else {
  // Fallback to file path
  const ownerKeypairPathRaw = process.env.POOL_OWNER_KEYPAIR ?? './keys/pool-owner.json';
  const ownerKeypairPath = path.resolve(process.cwd(), ownerKeypairPathRaw);
  if (!fs.existsSync(ownerKeypairPath)) {
    throw new Error(
      `Owner keypair not found. Set POOL_OWNER_PRIVATE_KEY (private key as JSON array) or POOL_OWNER_KEYPAIR (path to keypair file).`,
    );
  }
  ownerKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(ownerKeypairPath, 'utf8'))),
  );
}

const feeBufferRaw = process.env.CREATOR_TRANSFER_FEE_BUFFER_LAMPORTS ?? '5000';
const feeBufferLamports = BigInt(feeBufferRaw);
if (feeBufferLamports < 0n) {
  throw new Error('CREATOR_TRANSFER_FEE_BUFFER_LAMPORTS must be non-negative.');
}

const rewardThresholdSol = Number(process.env.REWARD_THRESHOLD_SOL ?? '0');
if (!Number.isFinite(rewardThresholdSol) || rewardThresholdSol < 0) {
  throw new Error('REWARD_THRESHOLD_SOL must be a non-negative number.');
}
const thresholdLamports = BigInt(Math.floor(rewardThresholdSol * LAMPORTS_PER_SOL));

function loadIdl(): Idl & { address?: string } {
  // First, try to load from environment variable
  if (process.env.REWARD_POOL_IDL) {
    try {
      return JSON.parse(process.env.REWARD_POOL_IDL) as Idl & { address?: string };
    } catch (error) {
      throw new Error('Failed to parse REWARD_POOL_IDL environment variable. Ensure it is valid JSON.');
    }
  }

  // Fallback to file path
  const idlPath = path.join(__dirname, '../target/idl/reward_pool.json');
  if (!fs.existsSync(idlPath)) {
    throw new Error(
      `Reward pool IDL not found. Set REWARD_POOL_IDL environment variable or ensure ${idlPath} exists.`,
    );
  }

  return JSON.parse(fs.readFileSync(idlPath, 'utf8')) as Idl & { address?: string };
}

function deriveVaultAddress(): PublicKey {
  if (process.env.VAULT_ADDRESS) {
    return new PublicKey(process.env.VAULT_ADDRESS);
  }

  const rawIdl = loadIdl();
  if (!rawIdl.address) {
    throw new Error('Program address missing from reward_pool IDL.');
  }

  const programId = new PublicKey(rawIdl.address);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from('vault')], programId);
  return vault;
}

function formatSol(lamports: bigint): string {
  return (Number(lamports) / LAMPORTS_PER_SOL).toFixed(9);
}

type HolderInfo = {
  address: PublicKey;
  balance: anchor.BN;
};

type HolderMap = Map<string, anchor.BN>;

async function fetchTopHolders(connection: Connection, limit: number): Promise<HolderInfo[]> {
  const mintPubkey = new PublicKey(TOKEN_MINT);
  const largest = await connection.getTokenLargestAccounts(mintPubkey, commitment);
  if (!largest.value || largest.value.length === 0) {
    return [];
  }

  // Fetch more accounts than needed to account for aggregation by owner
  const upperBound = Math.min(largest.value.length, limit * 2);
  const tokenAccountPubkeys = largest.value
    .slice(0, upperBound)
    .map((item) => new PublicKey(item.address));

  const accountInfos = await connection.getMultipleAccountsInfo(tokenAccountPubkeys, commitment);
  const holderMap: HolderMap = new Map();
  const { BN } = anchor;

  accountInfos.forEach((info, idx) => {
    if (!info) {
      return;
    }

    try {
      const decoded = AccountLayout.decode(info.data);
      const owner = new PublicKey(decoded.owner as Buffer);

      // Filter out program-owned accounts (off-curve addresses like PDAs)
      if (!PublicKey.isOnCurve(owner.toBuffer())) {
        console.log(
          `   ↳ Skipping off-curve owner ${owner.toBase58()} for token account ${
            tokenAccountPubkeys[idx]?.toBase58() ?? 'unknown'
          }`,
        );
        return;
      }

      let amount: anchor.BN;
      if (typeof decoded.amount === 'bigint') {
        amount = new BN(decoded.amount.toString());
      } else {
        const amountBuffer = Buffer.from(decoded.amount as Buffer);
        amount = new BN(amountBuffer, undefined, 'le');
      }

      // Skip accounts with zero balance
      if (amount.isZero()) {
        return;
      }

      const key = owner.toBase58();
      const existing = holderMap.get(key) ?? new BN(0);
      holderMap.set(key, existing.add(amount));
    } catch (error) {
      console.warn(
        `⚠️  Unable to decode token account ${tokenAccountPubkeys[idx]?.toBase58()}:`,
        error,
      );
    }
  });

  // No sorting needed for equal distribution - just take first N holders
  return Array.from(holderMap.entries())
    .slice(0, limit)
    .map(([address, balance]) => ({
      address: new PublicKey(address),
      balance,
    }));
}

async function main(): Promise<void> {
  const connection = new Connection(RPC_URL, commitment);
  const pumpSdk = new OnlinePumpSdk(connection);
  const vaultPubkey = deriveVaultAddress();

  const ownerWallet = new anchor.Wallet(ownerKeypair);
  const ownerProvider = new anchor.AnchorProvider(connection, ownerWallet, { commitment });
  anchor.setProvider(ownerProvider);

  console.log('⚙️  Pump.fun reward collector');
  console.log('RPC endpoint:', RPC_URL);
  console.log('Developer wallet:', developerKeypair.publicKey.toBase58());
  console.log('Pool owner wallet:', ownerKeypair.publicKey.toBase58());
  console.log('Vault address:', vaultPubkey.toBase58());

  // Check for pending creator fees
  const pendingLamportsBn = await pumpSdk.getCreatorVaultBalanceBothPrograms(developerPubkey);
  const pendingLamports = BigInt(pendingLamportsBn.toString());

  if (pendingLamports === 0n) {
    console.log('ℹ️  No pending creator rewards to claim.');
    return;
  }

  if (pendingLamports < thresholdLamports) {
    console.log(
      `ℹ️  Pending rewards ${formatSol(pendingLamports)} SOL below threshold ${rewardThresholdSol.toFixed(3)} SOL. Skipping claim.`,
    );
    return;
  }

  console.log(
    `💰 Pending rewards: ${formatSol(pendingLamports)} SOL (${pendingLamports.toString()} lamports) across Pump and PumpSwap vaults`,
  );

  // Track balance before collecting fees
  const developerBalanceBefore = BigInt(await connection.getBalance(developerKeypair.publicKey, commitment));
  console.log(`📊 Developer wallet balance before collection: ${formatSol(developerBalanceBefore)} SOL`);

  // Collect creator fees
  console.log('🧾 Collecting creator fees from Pump.fun...');
  const instructions = await pumpSdk.collectCoinCreatorFeeInstructions(developerPubkey);
  if (!instructions || instructions.length === 0) {
    console.log('ℹ️  No collection instructions generated.');
    return;
  }

  const collectTx = new Transaction();
  instructions.forEach((ix) => collectTx.add(ix));

  const { blockhash: collectBlockhash, lastValidBlockHeight: collectLvb } =
    await connection.getLatestBlockhash(commitment);
  collectTx.recentBlockhash = collectBlockhash;
  collectTx.feePayer = developerKeypair.publicKey;

  collectTx.sign(developerKeypair);
  const collectSignature = await connection.sendRawTransaction(collectTx.serialize());
  await connection.confirmTransaction(
    { signature: collectSignature, blockhash: collectBlockhash, lastValidBlockHeight: collectLvb },
    commitment,
  );
  console.log('✅ Fees collected. Signature:', collectSignature);

  // Check for WSOL in developer's ATA and unwrap if present
  const wsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    developerKeypair.publicKey,
    true,
    TOKEN_PROGRAM_ID
  );

  const wsolAtaInfo = await connection.getAccountInfo(wsolAta, commitment);

  if (wsolAtaInfo) {
    const decoded = AccountLayout.decode(wsolAtaInfo.data);
    let wsolAmount: bigint;

    if (typeof decoded.amount === 'bigint') {
      wsolAmount = decoded.amount;
    } else {
      const amountBuffer = Buffer.from(decoded.amount as Buffer);
      wsolAmount = amountBuffer.readBigUInt64LE(0);
    }

    if (wsolAmount > 0n) {
      console.log(`🪙 Found ${formatSol(wsolAmount)} wSOL in ATA. Unwrapping...`);

      // Close WSOL ATA to unwrap wSOL → native SOL
      const unwrapTx = new Transaction().add(
        createCloseAccountInstruction(
          wsolAta,
          developerKeypair.publicKey,
          developerKeypair.publicKey,
          [],
          TOKEN_PROGRAM_ID
        )
      );

      const { blockhash: unwrapBlockhash, lastValidBlockHeight: unwrapLvb } =
        await connection.getLatestBlockhash(commitment);
      unwrapTx.recentBlockhash = unwrapBlockhash;
      unwrapTx.feePayer = developerKeypair.publicKey;

      unwrapTx.sign(developerKeypair);
      const unwrapSignature = await connection.sendRawTransaction(unwrapTx.serialize());
      await connection.confirmTransaction(
        { signature: unwrapSignature, blockhash: unwrapBlockhash, lastValidBlockHeight: unwrapLvb },
        commitment,
      );
      console.log('✅ WSOL unwrapped. Signature:', unwrapSignature);
    } else {
      console.log('ℹ️  WSOL ATA exists but has 0 balance.');
    }
  } else {
    console.log('ℹ️  No WSOL ATA found (rewards may already be in native SOL).');
  }

  // Check balance after collection and unwrapping
  const developerBalanceAfter = BigInt(await connection.getBalance(developerKeypair.publicKey, commitment));
  console.log(`📊 Developer wallet balance after collection/unwrapping: ${formatSol(developerBalanceAfter)} SOL`);

  // Calculate the actual collected amount (accounting for tx fees)
  const collectedAmount = developerBalanceAfter > developerBalanceBefore
    ? developerBalanceAfter - developerBalanceBefore
    : 0n;

  if (collectedAmount === 0n) {
    console.log('⚠️  No net increase in balance after collection (may have only covered fees).');
    return;
  }

  console.log(`💵 Collected rewards amount: ${formatSol(collectedAmount)} SOL (${collectedAmount.toString()} lamports)`);

  // Ensure we have enough for fee buffer
  if (developerBalanceAfter <= feeBufferLamports) {
    console.log('⚠️  Developer wallet balance is too low after claim; skipping transfer to vault.');
    return;
  }

  // Transfer ONLY the collected rewards to vault, not entire balance
  const lamportsToSend = collectedAmount > feeBufferLamports ? collectedAmount - feeBufferLamports : collectedAmount;

  if (lamportsToSend <= 0n) {
    console.log('⚠️  Collected amount is too small to transfer after reserving fee buffer.');
    return;
  }

  if (lamportsToSend > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Transfer amount is too large for JS number conversion.');
  }

  console.log(
    `🏦 Transferring ${formatSol(lamportsToSend)} SOL (${lamportsToSend.toString()} lamports) from collected rewards to vault.`,
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(commitment);
  const transferTx = new Transaction({
    feePayer: developerKeypair.publicKey,
    recentBlockhash: blockhash,
  }).add(
    SystemProgram.transfer({
      fromPubkey: developerKeypair.publicKey,
      toPubkey: vaultPubkey,
      lamports: Number(lamportsToSend),
    }),
  );

  const transferSignature = await connection.sendTransaction(transferTx, [developerKeypair]);
  await connection.confirmTransaction({ signature: transferSignature, blockhash, lastValidBlockHeight }, commitment);
  console.log('✅ Vault funded. Signature:', transferSignature);

  // Fetch holders for distribution (no sorting needed for equal distribution)
  console.log('👥 Fetching token holders for distribution...');
  const holders = await fetchTopHolders(connection, 20);
  console.log(`   Retrieved ${holders.length} unique holders (filtered for human accounts).`);

  holders.forEach((holder, index) => {
    console.log(
      `   ${index + 1}. ${holder.address.toBase58()} — ${holder.balance.toString()} tokens`,
    );
  });

  if (holders.length === 0) {
    console.log('⚠️  No eligible holders found; skipping distribution.');
    return;
  }

  const rentExemptLamports = BigInt(await connection.getMinimumBalanceForRentExemption(0));
  const vaultLamports = BigInt(await connection.getBalance(vaultPubkey, commitment));

  if (vaultLamports <= rentExemptLamports) {
    console.log(
      `ℹ️  Vault balance ${formatSol(vaultLamports)} SOL is at/below rent buffer ${formatSol(rentExemptLamports)} SOL. Skipping distribution.`,
    );
    return;
  }

  const distributableLamports = vaultLamports - rentExemptLamports;
  const equalShareLamports = distributableLamports / BigInt(holders.length);

  if (equalShareLamports === 0n) {
    console.log(
      '⚠️  Distributable rewards per holder are below 1 lamport after retaining rent buffer; skipping distribution.',
    );
    return;
  }

  console.log(
    `💸 Distributable rewards: ${formatSol(distributableLamports)} SOL (retaining ${formatSol(
      rentExemptLamports,
    )} SOL for rent). Each holder will receive ${formatSol(equalShareLamports)} SOL.`,
  );

  // Set up reward distribution program
  const rawIdl = loadIdl();
  if (!rawIdl.address) {
    throw new Error('Program address missing from reward_pool IDL.');
  }
  const program = new anchor.Program(rawIdl as Idl, ownerProvider);
  const programId = program.programId;
  const [poolPDA] = PublicKey.findProgramAddressSync([Buffer.from('pool')], programId);
  const [vaultPDA] = PublicKey.findProgramAddressSync([Buffer.from('vault')], programId);

  console.log('📍 Pool PDA:', poolPDA.toBase58());
  console.log('🏦 Vault PDA:', vaultPDA.toBase58());

  // Create distribution instruction
  const ix = await program.methods
    .distributeRewards(holders)
    .accounts({
      pool: poolPDA,
      poolVault: vaultPDA,
      authority: ownerWallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(
      holders.map(({ address }) => ({
        pubkey: address,
        isWritable: true,
        isSigner: false,
      })),
    )
    .instruction();

  const distributionTx = new Transaction().add(ix);
  const distributionSignature = await ownerProvider.sendAndConfirm(distributionTx, []);
  console.log('✅ Distribution submitted. Signature:', distributionSignature);
}

main()
  .then(() => {
    console.log('✨ Pump.fun rewards collected, forwarded, and distributed.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Reward collection failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
