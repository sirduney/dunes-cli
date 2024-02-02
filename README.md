# Dunes

A minter and protocol for dunes on Dogecoin.

## ⚠️⚠️⚠️ Important ⚠️⚠️⚠️

Use this wallet for dunes only! Always mint from this wallet to a different address. This wallet is not meant for storing funds or dunes.

## Prerequisites

To use this, you'll need to use your console/terminal and install Node.js on your computer. So please ensure, that you have your

### Install NodeJS

Please head over to [https://nodejs.org/en/download](https://nodejs.org/en/download) and follow the installation instructions.

### Launch your own RPC

In order to inscribe, you will need to have access to a Dodgecoin RPC. For example: [https://getblock.io/](https://getblock.io/) provides a service to get access to an RPC.
You will need that for the configuration.

## Setup

### git clone and install

Install by git clone (requires git and node on your computer)

#### git clone

```
git clone https://github.com/verydogelabs/do20nals.git
```

**or**

download this [zip file](https://github.com/verydogelabs/do20nals/archive/refs/heads/main.zip) and upack in a directory.

Now open your terminal and change to the directory the sources are installed.

####

```
cd <path to your download / installation>
npm install
```

After all dependencies are solved, you can configure the environment:

### Configure environment

Copy a `.env.example` to `.env` and add your node information:

```
PROTOCOL_IDENTIFIER=
NODE_RPC_URL=http://<ip>:<port>
# This is optional if you have an RPC from getblock.io
NODE_RPC_USER=<username>
NODE_RPC_PASS=<password>
TESTNET=false
FEE_PER_KB=500000000
```

You can get the current fee per kb from [here](https://blockchair.com/).

## Dunes

todo

## Funding

Generate a new `.wallet.json` file:

```
node dunes.js wallet new
```

Then send DOGE to the address displayed. Once sent, sync your wallet:

```
node dunes.js wallet sync
```

If you are minting a lot, you can split up your UTXOs:

```
node dunes.js wallet split <splits>
```

When you are done minting, send the funds back:

```
node dunes.js wallet send <address> <amount>
```

## FAQ

### I'm getting ECONNREFUSED errors when minting

There's a problem with the node connection. Your `dogecoin.conf` file should look something like:

```
rpcuser=ape
rpcpassword=zord
rpcport=22555
server=1
```

Make sure `port` is not set to the same number as `rpcport`. Also make sure `rpcauth` is not set.

Your `.env file` should look like:

```
NODE_RPC_URL=http://127.0.0.1:22555
NODE_RPC_USER=ape
NODE_RPC_PASS=zord
TESTNET=false
```

### I'm getting "insufficient priority" errors when minting

The miner fee is too low. You can increase it up by putting FEE_PER_KB=300000000 in your .env file or just wait it out. The default is 100000000 but spikes up when demand is high.
