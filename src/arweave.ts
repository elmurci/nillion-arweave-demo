import Arweave from 'arweave';
import { JWKInterface } from 'arweave/node/lib/wallet';
import { logger } from 'src/logger';
import { TurboFactory, ArweaveSigner } from "@ardrive/turbo-sdk";

const ARWEAVE_HOST = "arweave.net"; // TODO: move to config

export async function createWallet() {
  try {
    const arweave = Arweave.init({
          host: ARWEAVE_HOST,
          port: 1984,
          protocol: 'http',
          timeout: 20000,
          logging: true,
    });

    // Generate a new wallet
    const wallet = await arweave.wallets.generate();
    // Get the wallet address
    const address = await arweave.wallets.jwkToAddress(wallet);

    return {
        wallet,
        address
    };

  } catch (error) {
    logger.error('Error creating wallet:', error);
  }
}

export const uploadFile = async (data: string, wallet: JWKInterface) => {

  try {
    const signer = new ArweaveSigner(wallet);
    // Initialize Turbo
    const turbo = TurboFactory.authenticated({ signer });

    const result = await turbo.upload({
      data,
      dataItemOpts: {
      tags: [
        { name: "Content-Type", value: " text/plain" },
        { name: "Title", value: "My demo file" },
      ],
    },
    });

    return result;
    
  } catch (error) {
    logger.error('Error uploading securely encrypted file:', error);
  }
}