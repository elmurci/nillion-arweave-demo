import { SecretVaultBuilderClient, SecretVaultUserClient, Uuid } from "@nillion/secretvaults";
import { createWallet, downloadFile, uploadFile } from "./arweave";
import { JWKInterface } from "arweave/node/lib/wallet";
import { logger } from "./logger";
import {
  Keypair,
  Command,
  NucTokenBuilder,
  Did,
  NucTokenEnvelope,
  DelegationBody,
  InvocationBody,
} from "@nillion/nuc";
import fs from "fs";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { randomUUID } from "node:crypto";
import { SecretKey } from "@nillion/blindfold";
import { bytesToHex } from "@noble/curves/utils";

import "dotenv/config"

export type AppConfig = {
    NILCHAIN_URL: string;
    NILAUTH_URL: string;
    NILDB_NODES: string[];
    NIL_PAYER_PRIVATE_KEY: string;
    NIL_BUILDER_PRIVATE_KEY: string;
    NIL_BUILDER_COLLECTION_ID: string;
};

const config: AppConfig = {
    NILCHAIN_URL:
        process.env.NILCHAIN_URL ||
        "http://rpc.testnet.nilchain-rpc-proxy.nilogy.xyz",
    NILAUTH_URL:
        process.env.NILAUTH_URL ||
        "https://nilauth.sandbox.app-cluster.sandbox.nilogy.xyz",
    NILDB_NODES: process.env.NILDB_NODES
        ? process.env.NILDB_NODES.split(",")
        : [
                "https://nildb-stg-n1.nillion.network",
                "https://nildb-stg-n2.nillion.network",
                "https://nildb-stg-n3.nillion.network",
          ],
    NIL_BUILDER_PRIVATE_KEY: process.env.NIL_BUILDER_PRIVATE_KEY!,
    NIL_BUILDER_COLLECTION_ID: process.env.NIL_BUILDER_COLLECTION_ID!,
};

const downloadFile = async (url: string, location: string) => {
  try {
    const response = await fetch(url);
    const data = await response.text();

    // Use fs.promises.writeFile
    await fs.promises.writeFile(location, data);

    logger.log(`💾 Downloaded file saved to: ${location}`);
    
  } catch (error) {
    logger.error("❌ Download file failed:", error);
  }
};

const encryptContent = (content: Buffer, encryptionKey: string): Buffer => {
  // Convert hex private key to buffer
  const privateKeyBuffer = Buffer.from(encryptionKey, "hex");
  
  // Derive a 32-byte encryption key from your private key using SHA-256
  const derivedKey = createHash("sha256").update(privateKeyBuffer).digest();
  
  // Validate derived key length (should be 32 bytes for AES-256)
  if (derivedKey.length !== 32) {
    throw new Error("Derived encryption key must be exactly 32 bytes for AES-256");
  }
  
  // Generate secure encryption parameters
  const iv = randomBytes(16);

  // Encrypt using AES-256-GCM
  const cipher = createCipheriv("aes-256-gcm", derivedKey, iv);
  
  let encrypted = cipher.update(content);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  
  // Get the authentication tag (16 bytes for GCM)
  const authTag = cipher.getAuthTag();
  
  // Combine IV + authTag + encrypted data into a single buffer
  // Format: [16 bytes IV][16 bytes auth tag][encrypted data]
  return Buffer.concat([iv, authTag, encrypted]);
};

// Decryption function
const decryptContent = (encryptedData: Buffer, encryptionKey: string, outputLocation: string): Buffer => {
  // Convert hex private key to buffer
  const privateKeyBuffer = Buffer.from(encryptionKey, "hex");
  
  // Derive the same 32-byte encryption key using SHA-256
  const derivedKey = createHash("sha256").update(privateKeyBuffer).digest();
  
  // Validate derived key length
  if (derivedKey.length !== 32) {
    throw new Error("Derived encryption key must be exactly 32 bytes for AES-256");
  }
  
  // Extract IV, auth tag, and encrypted content
  // Format: [16 bytes IV][16 bytes auth tag][encrypted data]
  if (encryptedData.length < 32) {
    throw new Error("Invalid encrypted data: too short");
  }
  
  const iv = encryptedData.subarray(0, 16);
  const authTag = encryptedData.subarray(16, 32);
  const encrypted = encryptedData.subarray(32);
  
  // Create decipher
  const decipher = createDecipheriv("aes-256-gcm", derivedKey, iv);
  
  // Set the authentication tag
  decipher.setAuthTag(authTag);
  
  // Decrypt the data
  let decrypted = decipher.update(encrypted);
  decrypted = Buffer.concat([decrypted, decipher.final()]);

  logger.info("✅ Successfully decrypted!");
  logger.info("Original size:", decrypted.length);
  
  // Save decrypted file
  fs.writeFileSync(outputLocation, decrypted);
  logger.log(`💾 Decrypted file saved to: ${outputLocation}`);
  
  return decrypted;
};

const generateToken = async (
  parentToken: NucTokenEnvelope,
  command: Command,
  audience: Did,
  tokenExpirySeconds: number,
  privateKey: Uint8Array<ArrayBufferLike>,
  body?: DelegationBody | InvocationBody,
) => {
  const token = NucTokenBuilder.extending(parentToken)
    .command(command)
    .audience(audience)
    .expiresAt(Math.floor(Date.now() / 1000) + tokenExpirySeconds);
  
  if (body) token.body(body);

  return token.build(privateKey);
}

const init = async () => {
  try {
    let collectionId;
    const dataId = randomUUID();

    // Builder Client
    const builderKeypair = Keypair.from(config.NIL_BUILDER_PRIVATE_KEY);
    const builder = await SecretVaultBuilderClient.from({
        keypair: builderKeypair,
        urls: {
            chain: config.NILCHAIN_URL,
            auth: config.NILAUTH_URL,
            dbs: config.NILDB_NODES,
        },
        blindfold: {
          operation: "store",
        }
    });

    await builder.refreshRootToken();

    // Let"s make sure we have created the builder client correctly
    const existingProfile = await builder.readProfile();

    // Let"s create the Owned Collection, if it doesn"t exist
    if (!config.NIL_BUILDER_COLLECTION_ID) {
      collectionId = randomUUID();
      const schema = {
        "$schema": "http://json-schema.org/draft-07/schema#",
        type: "array",
        items: {
          type: "object",
          properties: {
              _id: {
                "type": "string",
                "format": "uuid"
              },
              private_key: {
                "type": "object",
                "properties": {
                  "%share": {
                    "type": "string"
                  }
                },
                required: ["%share"]
              }
            },
            required: ["_id", "private_key"]
        }
      };
      const collection: {
          _id: string
          type: "owned"
          name: string
          schema: Record<string, unknown>
        } = {
          _id: collectionId,
          type: "owned",
          name: "Nillion / Arweave Demo App User Profiles",
          schema,
        };
    
      
      const collectionResult = await builder.createCollection(collection);
      logger.log(`✅ Created Owned Collection with ID: ${collectionId}`);
      logger.log(`Make sure to update your .env file with this NIL_BUILDER_COLLECTION_ID to proceed.`);
      process.exit(0);
    } else {
      if (existingProfile.data.collections.indexOf(config.NIL_BUILDER_COLLECTION_ID) === -1) {
        throw new Error(`Builder does not have collection ${config.NIL_BUILDER_COLLECTION_ID} registered. Please check your .env configuration.`);
      } else {
        logger.log(`✅ Builder is set up correctly with DID: ${builder.did}`);
        logger.log(`✅ Using Owned Collection ID: ${config.NIL_BUILDER_COLLECTION_ID}`);
        collectionId = config.NIL_BUILDER_COLLECTION_ID;
      }
    }

    // Create user and store its private key in nilDB
    const secretKey = await SecretKey.generate({"nodes": config.NILDB_NODES.map(url => ({ url }))}, {"store": true});
    const userKeypair = Keypair.from(bytesToHex(secretKey.material as Uint8Array));
    const userDid = userKeypair.toDid().toString();
    const user = await SecretVaultUserClient.from({
        baseUrls: config.NILDB_NODES,
        keypair: userKeypair,
        blindfold: {
          operation: "store"
        }
    });

    // Grant write access to the user
    const delegationToken = await generateToken(
      builder.rootToken,
      new Command(["nil", "db", "data", "create"]),
      userKeypair.toDid(),
      3600, // 1 hour
      builder.keypair.privateKey()
    );

    logger.log(`🗝️ Delegation token created`);

    // User creates profile with Private Key
    await user.createData(delegationToken, {
        owner: userDid,
        acl: {
            grantee: builder.did.toString(), // Grant access to the builder
            read: false, // Builder can read the data
            write: false, // Builder cannot modify the data
            execute: true, // Builder can run queries on the data
        },
        collection: collectionId,
        data: [
          {
            _id: dataId,
            private_key: {
              "%allot": userKeypair.privateKey(),
            },
          }
        ],
    });

    logger.log(`✅ User profile created: ${userDid}`);

    const wallet = await createWallet();

    logger.log(`💼 Arweave wallet created: ${wallet?.address}`);

    // Retrieve the user private key from nilDB
    const retrievedUserKey = await user.readData({
      collection: collectionId,
      document: dataId,
    });

    // Encrypt file contents
    const fileData = fs.readFileSync("test/demo.txt");
    const encrypted = encryptContent(fileData, retrievedUserKey.data.private_key as string);
    const upload = await uploadFile(encrypted, wallet?.wallet!);
    logger.log(`✅ File uploaded to Arweave with txId: ${upload.id}`);

    // Download the file and decrypt it
    const downloadFileName = `./test/encrypted_demo_${Date.now()}.txt`;
    logger.log(`🕒 Downloading file from Airweave`);
    await downloadFile(`https://arweave.net/${upload.id}`, downloadFileName);
    const decrypted = decryptContent(encrypted, retrievedUserKey.data.private_key as string, `./test/decrypted_demo_${Date.now()}.txt`)


  } catch (error: any) {
    console.log(error)
    logger.error("⚠️ Error setting up builder:", JSON.stringify(error, null, 2));
  }

}

init();