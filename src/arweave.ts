import { bytesToHex } from '@noble/curves/utils';
import Arweave from 'arweave';
import { JWKInterface } from 'arweave/node/lib/wallet';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import fs from "fs";
import { logger } from 'src/logger';
import { TurboFactory, ArweaveSigner } from "@ardrive/turbo-sdk";
import fs from "fs";

export async function createWallet() {
  try {
    const arweave = Arweave.init({
          host: 'arweave.net',
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

async function mintTokens(
  address: string, 
  amount: string | number, 
  host: string = 'localhost', 
  port: number = 1984
): Promise<void> {
  const url = `http://${host}:${port}/mint/${address}/${amount}`;
  
  try {

    const response = await fetch(url);
    
    if (!response.ok) {
      logger.error('❌ Failed to mint tokens');
    }
  } catch (error) {
    logger.error('❌ Error minting tokens:', error);
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

const getData = async (txId: string) => {
    try {
        const arweave = Arweave.init({
            host: 'localhost',
            port: 1984,
            protocol: 'http',
            timeout: 20000,
            logging: false,
        });
        
        // Download encrypted data as Buffer
        const encryptedDataRaw = await arweave.transactions.getData(txId, { decode: true, string: false });
        
        // Ensure we have a Buffer
        const encryptedData = Buffer.from(encryptedDataRaw);
        
        return encryptedData;
        
    } catch (error) {
        logger.error('❌ Decryption failed:', error);
    }
};