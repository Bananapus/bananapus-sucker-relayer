# bananapus-sucker-relayer
Tool that automatically performs the proving and finalization for L2 -> L1 transactions, build for L2s that run the OP Stack.

**Unstable and not ready for production**

## Run with docker

Create the `.env` file.

Build the container:
```bash
docker build -t bananapus-sucker-relayer .
```

Start the container:

```bash
docker run  bananapus-sucker-relayer
```

## Run on local machine (or for development)

Create the `.env` file.

Install the dependencies:
```bash
bun install
```

Run the relayer:
```bash
bun run index.ts
```