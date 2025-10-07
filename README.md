# Reward Pool Program
> Anchor program for automated SOL reward distribution for Pump.fun creator tokens.

This repository hosts the on-chain Anchor program that manages SOL reward pools for Pump.fun launches. The companion off-chain worker (kept in a private repository) polls creator rewards, deposits them into the program’s vault, and triggers periodic distributions to the top token holders.

Twitter: [@RushDotFun](https://x.com/RushDotFun)  
Website: [rushdot.fun](https://rushdot.fun)

## How It Works
- Every five minutes the private Render cron job queries Pump.fun creator rewards for the configured token.
- The worker sends collected SOL into the program’s vault account.
- When enough SOL has accumulated, the worker submits a `distribute_rewards` instruction with the top 20 holders and their payout accounts.
- Holders receive an equal share of the distributable balance, while the vault retains the rent-exempt minimum.
- An emergency `owner_withdraw` instruction lets the pool owner recover funds if needed.

## Repository Layout
- `Cargo.toml` – program crate manifest.
- `Anchor.toml` – Anchor configuration; wallet paths and RPC URLs are supplied locally.
- `src/lib.rs` – Anchor program logic (initialize, distribute, withdraw).
- `idl/reward_pool.json` – Generated Anchor IDL for clients that need instruction metadata.
- `.env.example` – Reference environment variables needed by local scripts/tests (copy to `.env` and fill values before running Anchor commands).

## Prerequisites
- Rust with the Solana target (`rustup target add bpfel-unknown-unknown`).
- Solana CLI (v1.18+ recommended) configured with access to your target cluster.
- Anchor CLI v0.31.1 (see `Anchor.toml`).
- Node.js / Yarn if you plan to run the TypeScript tests.

## Quick Start
```bash
# install deps
anchor build

# run Anchor tests (requires .env populated and local validator or RPC access)
anchor test
