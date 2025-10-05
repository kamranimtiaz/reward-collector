# Render Cron Job Deployment Guide

This guide shows you how to deploy the Solana Yield Distributor reward collection script as a Render Cron Job.

## Overview

The cron job will automatically:
1. Check for pending Pump.fun creator rewards
2. Collect the rewards if above threshold
3. Transfer rewards to the vault
4. Distribute rewards equally to top 20 token holders

## Prerequisites

Before deploying to Render, ensure you have:

✅ Deployed the Solana reward pool program
✅ Initialized the pool with the correct owner
✅ The program's IDL file at `target/idl/reward_pool.json`
✅ Private keys for both developer and pool owner wallets
✅ A Render account (free tier works)

---

## Step 1: Prepare Your Environment Variables

### 1.1 Get Your Program IDL

After deploying your program, you'll need the entire IDL as a minified JSON string:

```bash
# From your project directory
cat target/idl/reward_pool.json | jq -c
```

Copy the entire output (it's a long single-line JSON string).

### 1.2 Convert Private Keys to JSON Array Format

Render environment variables work best with private keys as JSON arrays:

```bash
# View your keypair file
cat keys/pump-developer.json
# Output: [1,2,3,4,5,...]

cat keys/pool-owner.json
# Output: [1,2,3,4,5,...]
```

Copy these arrays for the next step.

### 1.3 Environment Variables Checklist

Prepare these values (refer to [.env.render.example](.env.render.example)):

| Variable | Example | Required |
|----------|---------|----------|
| `SOLANA_RPC_URL` | `https://mainnet.helius-rpc.com/?api-key=xxx` | ✅ Yes |
| `TOKEN_MINT` | `3ZEtKTaWvCHN71xnTVMsMGJt9SvMqXB3MaJYLangpump` | ✅ Yes |
| `PUMPFUN_DEVELOPER_PRIVATE_KEY` | `[1,2,3,...]` | ✅ Yes |
| `POOL_OWNER_PRIVATE_KEY` | `[1,2,3,...]` | ✅ Yes |
| `REWARD_POOL_IDL` | `{"address":"D9WHX...","metadata":{...}}` | ✅ Yes |
| `REWARD_THRESHOLD_SOL` | `0.0001` | Optional (default: 0) |
| `CREATOR_TRANSFER_FEE_BUFFER_LAMPORTS` | `5000` | Optional (default: 5000) |

---

## Step 2: Deploy to Render

### Option A: Deploy via Blueprint (Recommended)

1. **Push to GitHub**
   ```bash
   git add .
   git commit -m "Add Render deployment config"
   git push origin main
   ```

2. **Create Render Service**
   - Go to [Render Dashboard](https://dashboard.render.com/)
   - Click **New +** → **Blueprint**
   - Connect your GitHub repository
   - Render will auto-detect `render.yaml`

3. **Set Environment Variables**
   - During blueprint setup, Render will prompt for required env vars
   - Paste the values you prepared in Step 1.3

4. **Review and Deploy**
   - Verify the cron schedule (default: every 15 minutes)
   - Click **Apply** to deploy

### Option B: Manual Cron Job Creation

1. **Go to Render Dashboard**
   - Navigate to [dashboard.render.com](https://dashboard.render.com/)

2. **Create New Cron Job**
   - Click **New +** → **Cron Job**

3. **Configure Repository**
   - Connect your GitHub/GitLab repository
   - Select the repository containing this project
   - Branch: `main` (or your default branch)

4. **Configure Build & Run Commands**
   - **Name:** `solana-reward-collector`
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Command:** `npm run rewards:collect`

5. **Set Cron Schedule**
   Choose your schedule (use cron format):
   - Every 15 minutes: `*/15 * * * *`
   - Every hour: `0 * * * *`
   - Every 4 hours: `0 */4 * * *`
   - Daily at midnight: `0 0 * * *`

6. **Add Environment Variables**
   Click **Advanced** → **Add Environment Variable** for each:

   ```
   SOLANA_RPC_URL = your-rpc-url
   TOKEN_MINT = your-token-mint-address
   PUMPFUN_DEVELOPER_PRIVATE_KEY = [1,2,3,...]
   POOL_OWNER_PRIVATE_KEY = [1,2,3,...]
   REWARD_POOL_IDL = {"address":"..."}
   REWARD_THRESHOLD_SOL = 0.0001
   CREATOR_TRANSFER_FEE_BUFFER_LAMPORTS = 5000
   ```

7. **Create Cron Job**
   - Review settings
   - Click **Create Cron Job**

---

## Step 3: Verify Deployment

### Check Logs

1. Go to your cron job in Render Dashboard
2. Click **Logs** tab
3. Wait for the next scheduled run (or manually trigger)
4. Look for:
   ```
   ⚙️  Pump.fun reward collector
   RPC endpoint: https://...
   Developer wallet: BMY...
   Pool owner wallet: 2R1...
   Vault address: 4PY...
   ```

### Successful Run Indicators

✅ Script starts without errors
✅ Connects to RPC successfully
✅ Checks for pending rewards
✅ Either collects rewards or logs "No pending rewards"

### Common Issues

**Issue:** `REWARD_POOL_IDL environment variable not set`
**Fix:** Ensure you copied the entire minified IDL JSON

**Issue:** `Failed to parse PUMPFUN_DEVELOPER_PRIVATE_KEY`
**Fix:** Verify the private key is in JSON array format `[1,2,3,...]`

**Issue:** `Insufficient funds for fee`
**Fix:** Ensure the developer wallet has enough SOL for transaction fees (~0.001 SOL)

**Issue:** `Program address missing from reward_pool IDL`
**Fix:** Verify the IDL JSON contains the `"address"` field

---

## Step 4: Monitor & Maintain

### View Execution History

- Render Dashboard → Your Cron Job → **Runs** tab
- Shows each execution with success/failure status

### Update Configuration

To change environment variables:
1. Go to your cron job in Render
2. Click **Environment** tab
3. Edit values
4. Render will apply changes on next run (no redeploy needed)

### Adjust Schedule

1. Go to your cron job
2. Click **Settings** → **Cron Schedule**
3. Update the cron expression
4. Save changes

---

## Multiple Token Deployments

To run this for multiple tokens:

1. **Create separate cron jobs** for each token
   - Each with a unique name (e.g., `token-A-rewards`, `token-B-rewards`)

2. **Use different env vars** for each:
   - Different `TOKEN_MINT`
   - Different `PUMPFUN_DEVELOPER_PRIVATE_KEY`
   - Different `POOL_OWNER_PRIVATE_KEY`
   - Different `REWARD_POOL_IDL` (if different programs)

3. **Same codebase**, different configurations

---

## Cost Estimation

**Render Pricing (as of 2024):**
- Free tier: 90 hours/month of execution time
- Paid tier: $7/month for 200 hours

**Execution Time:**
- ~30 seconds per run (with rewards)
- ~5 seconds per run (no rewards)

**Example:**
- Running every 15 minutes = 96 runs/day
- ~8 minutes of execution time per day
- ~4 hours per month → **Free tier sufficient**

---

## Security Best Practices

✅ **Never commit private keys** to git
✅ **Use environment variables** for all secrets
✅ **Limit wallet balances** to minimum required
✅ **Monitor logs** for unauthorized access attempts
✅ **Rotate keys** periodically
✅ **Use separate wallets** for development vs. production

---

## Support & Troubleshooting

### Test Locally First

Before deploying to Render, test locally:

```bash
# Set environment variables in .env file
npm run rewards:collect
```

### Enable Detailed Logging

The script already includes detailed console output. Check Render logs for:
- RPC connection status
- Wallet addresses
- Pending reward amounts
- Transaction signatures

### Need Help?

- Check Render's [Cron Job Documentation](https://render.com/docs/cronjobs)
- Review your program's transaction history on Solana Explorer
- Verify wallet balances have sufficient SOL for fees

---

## Quick Reference

### Render Cron Job Settings

```yaml
Name: solana-reward-collector
Environment: Node
Build Command: npm install
Command: npm run rewards:collect
Schedule: */15 * * * *
```

### Required Environment Variables

```bash
SOLANA_RPC_URL=<your-rpc-url>
TOKEN_MINT=<your-token-mint>
PUMPFUN_DEVELOPER_PRIVATE_KEY=<json-array>
POOL_OWNER_PRIVATE_KEY=<json-array>
REWARD_POOL_IDL=<minified-idl-json>
```

---

**You're all set!** 🚀 Your automated reward collection and distribution system is now running on Render.
