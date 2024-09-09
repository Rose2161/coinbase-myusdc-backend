import { NextFunction, Request, Response } from "express";
import AppError from "../utils/appError";
import { AssetTransferRequest, FundWalletRequest } from "types/api.types";
import { Coinbase, Wallet } from "@coinbase/coinbase-sdk";
import { UserModel } from "../models/User.model";
import { coinbase } from "../services";
import { clerkClient } from "@clerk/clerk-sdk-node";
import { faucetConfig } from "../config";

export async function getUser(req: Request, res: Response, next: NextFunction) {
    try {
        let user = await UserModel.findOne({ userId: req.auth.userId });

        const _user = await clerkClient.users.getUser(req.auth.userId);

        // @todo - Update reward

        // If user doesn't exist, create user
        if (!user) {
            user = await (new UserModel({
                userId: _user.id,
                name: _user.firstName,
                email: _user.primaryEmailAddress?.emailAddress,
                imageUrl: _user.imageUrl,
                wallet: {},
                faucet: {}
            })).save();
        }

        // If wallet doesn't exist, create wallet
        if (!user.wallet?.id) {
            try {
                const wallet = await coinbase.createWalletForUser(user);
                const address = (await wallet.getDefaultAddress()).getId()

                // Fund the wallet
                try {
                    await coinbase.fundWallet(address, Coinbase.assets.Usdc, faucetConfig.INITIAL_AMOUNT);
                } catch (err) {
                    console.error(`[controllers/wallet/getUser] Failed to fund wallet |  User: ${user?.userId}`);
                    console.error(err);
                }
            } catch (err) {
                console.error(`[controllers/wallet/getUser] Failed to create wallet |  User: ${user?.userId}`);
                console.error(err);
            }
        }

        return res.status(200).json(user);
    } catch (error) {
        console.error(`[controllers/wallet/getUser] Failed to get user`);
        console.error(error);
        next(error);
    }
}

export async function transferAsset(req: AssetTransferRequest, res: Response, next: NextFunction) {
    try {
        const { asset, data } = req.body;
        const { recipient, amount } = data;

        let user = await UserModel.findOne({ userId: req.auth.userId });

        if (!user)
            throw new AppError(404, "error", "User not found");
        if (!user.wallet?.id)
            throw new AppError(404, "error", "Wallet not found");
        if (!asset || !data || !recipient || !amount)
            throw new AppError(400, "error", "Invalid request");

        const wallet = await Wallet.fetch(user.wallet?.id);

        if (asset == Coinbase.assets.Usdc) {
            const balance = await wallet.getBalance(asset);
            if (balance.lessThan(amount))
                throw new AppError(400, "error", "Insufficient balance");
        }
        else {
            throw new AppError(400, "error", "Unsupported asset");
        }

        const transfer = await (await wallet.createTransfer({
            amount: amount,
            assetId: asset,
            destination: recipient,
            gasless: asset == Coinbase.assets.Usdc ? true : false,
        })).wait();

        return res.status(200).json({
            transactionLink: transfer.getTransactionLink(),
            status: transfer.getStatus()
        });
    } catch (error) {
        console.error("[controllers/wallet/transferAsset] Transfer Failed: ", error);
        next(error);
    }
}

export async function fundWallet(req: FundWalletRequest, res: Response, next: NextFunction) {
    try {
        const { asset, amount } = req.body;

        if (!amount || !asset || amount > faucetConfig.MAX_REQUEST_AMOUNT)
            throw new AppError(400, "error", "Invalid request");

        let user = await UserModel.findOne({ userId: req.auth.userId });

        if (!user || !user.wallet?.id)
            throw new AppError(404, "error", "User not found");

        if ((user.faucet.amount + amount) > faucetConfig.MAX_TOTAL_AMOUNT)
            throw new AppError(400, "error", "Limit exceeded");

        if (user.faucet.lastRequested) {
            const now = new Date();
            const timeSinceLastRequest = (now.getTime() - user.faucet.lastRequested?.getTime()) / 1000;
            if (timeSinceLastRequest < faucetConfig.MIN_REQUEST_INTERVAL)
                throw new AppError(400, "error", "Too many requests");
        }

        if (!Object.values(Coinbase.assets).includes(asset))
            throw new AppError(400, "error", "Asset not supported");

        await coinbase.fundWallet(user.wallet.address as string, asset, amount);

        user.faucet.lastRequested = new Date();
        await user.save();

        return res.status(200).json(user);
    } catch (error) {
        console.error("[controllers/wallet/fundWallet] Funding Failed: ", error);
        next(error);
    }
}

