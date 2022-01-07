import { BalancerJoinExitFragment, InvestType } from '../balancer-subgraph/generated/balancer-subgraph-types';
import { BigNumber } from 'ethers';
import { fromFp } from '../util/numbers';
import _ from 'lodash';
import { TokenPrices } from '../token-price/token-price-types';
import { tokenPriceService } from '../token-price/token-price.service';
import {
    PrismaBalancerPoolSnapshotWithTokens,
    PrismaBalancerPoolTokenSnapshotWithToken,
    PrismaBlockExtended,
    PrismaFarmUserSnapshotWithFarm,
    UserPoolData,
    UserPortfolioData,
    UserTokenData,
} from './portfolio-types';
import moment from 'moment-timezone';
import { GqlUserPortfolioData, GqlUserTokenData } from '../../schema';
import { balancerTokenMappings } from '../token-price/lib/balancer-token-mappings';
import { env } from '../../app/env';
import { PortfolioDataService } from './lib/portfolio-data.service';
import { prisma } from '../prisma/prisma-client';
import {
    PrismaBalancerPool,
    PrismaBalancerPoolShareSnapshot,
    PrismaBeetsBarSnapshot,
    PrismaBeetsBarUserSnapshot,
} from '@prisma/client';

const CACHE_KEY_PREFIX = 'user-portfolio-history-all:';

class PortfolioService {
    dataService: PortfolioDataService;

    constructor() {
        this.dataService = new PortfolioDataService();
    }

    public async getPortfolio(address: string): Promise<UserPortfolioData> {
        const data = await this.dataService.getPortfolioDataForNow(address);

        if (data === null) {
            return {
                date: '',
                pools: [],
                tokens: [],
                totalValue: 0,
                totalSwapFees: 0,
                totalSwapVolume: 0,
                timestamp: 0,
                myFees: 0,
            };
        }

        const tokenPrices = await tokenPriceService.getTokenPrices();
        const historicalTokenPrices = await tokenPriceService.getHistoricalTokenPrices();
        const previousTokenPrices = tokenPriceService.getTokenPricesForTimestamp(
            data.previousBlock.timestamp,
            historicalTokenPrices,
        );

        const poolData = this.getUserPoolData(
            data.pools,
            data.block,
            data.previousBlock,
            tokenPrices,
            previousTokenPrices,
        );
        const tokens = this.tokensFromUserPoolData(poolData);

        return {
            pools: poolData,
            tokens,
            timestamp: moment().unix(),
            date: moment().format('YYYY-MM-DD'),
            totalValue: _.sumBy(poolData, 'totalValue'),
            totalSwapFees: _.sumBy(poolData, 'swapFees'),
            totalSwapVolume: _.sumBy(poolData, 'swapVolume'),
            myFees: _.sumBy(poolData, 'myFees'),
        };
    }

    public async cacheRawDataForTimestamp(timestamp: number): Promise<void> {
        await this.dataService.cacheRawDataForTimestamp(timestamp);
    }

    public async getPortfolioHistory(address: string): Promise<UserPortfolioData[]> {
        const portfolioHistories: UserPortfolioData[] = [];
        const historicalTokenPrices = await tokenPriceService.getHistoricalTokenPrices();
        const timestamp = moment.tz('GMT').startOf('day').subtract(30, 'days').unix();
        const pools = await prisma.prismaBalancerPool.findMany({});
        const blocks = await prisma.prismaBlock.findMany({
            where: { timestamp: { gte: timestamp } },
            include: {
                poolShares: { where: { userAddress: address } },
                pools: { include: { tokens: { include: { token: true } } } },
                farmUsers: { where: { userAddress: address }, include: { farm: true } },
                beetsBar: true,
                beetsBarUsers: { where: { address } },
            },
            orderBy: { timestamp: 'desc' },
        });

        //historical token prices haven't yet loaded, bail out of here
        if (Object.keys(historicalTokenPrices).length === 0) {
            return [];
        }

        for (let i = 0; i < blocks.length - 1; i++) {
            const block = blocks[i];
            const previousBlock = blocks[i + 1];
            const date = moment.unix(block.timestamp).subtract(1, 'day').format('YYYY-MM-DD');

            const tokenPrices = tokenPriceService.getTokenPricesForTimestamp(block.timestamp, historicalTokenPrices);
            const previousTokenPrices = tokenPriceService.getTokenPricesForTimestamp(
                previousBlock.timestamp,
                historicalTokenPrices,
            );

            const poolData = this.getUserPoolData(pools, block, previousBlock, tokenPrices, previousTokenPrices);
            const tokens = this.tokensFromUserPoolData(poolData);

            const totalValue = _.sumBy(poolData, 'totalValue');

            if (totalValue > 0) {
                const data = {
                    tokens,
                    pools: poolData,
                    //this data represents the previous day
                    timestamp: moment.unix(block.timestamp).subtract(1, 'day').unix(),
                    date,
                    totalValue,
                    totalSwapFees: _.sumBy(poolData, 'swapFees'),
                    totalSwapVolume: _.sumBy(poolData, 'swapVolume'),
                    myFees: _.sumBy(poolData, 'myFees'),
                };

                portfolioHistories.push(data);
            }
        }

        //await this.cachePortfolioHistory(address, portfolioHistories);

        return portfolioHistories;
    }

    public getUserPoolData(
        pools: PrismaBalancerPool[],
        block: PrismaBlockExtended,
        previousBlock: PrismaBlockExtended,
        tokenPrices: TokenPrices,
        previousTokenPrices: TokenPrices,
    ): UserPoolData[] {
        const userPoolData: Omit<UserPoolData, 'percentOfPortfolio'>[] = [];

        for (const pool of pools) {
            const snapshot = block.pools.find((snapshot) => snapshot.poolId === pool.id);

            if (!snapshot) {
                continue;
            }

            //if no previous snapshot, it means this pool is less than 24 hours old. Use the current pool so we get zeros
            const previousSnapshot = previousBlock.pools.find((snapshot) => snapshot.poolId === pool.id) || snapshot;

            const { userNumShares, userPercentShare, userTotalValue, userTokens, pricePerShare } =
                this.generatePoolIntermediates(
                    pool,
                    snapshot,
                    block.poolShares.filter((share) => share.poolId === pool.id),
                    block.farmUsers,
                    tokenPrices,
                    block.beetsBar,
                    block.beetsBarUsers[0] ?? null,
                );

            const previous = this.generatePoolIntermediates(
                pool,
                previousSnapshot,
                previousBlock.poolShares.filter((share) => share.poolId === pool.id),
                previousBlock.farmUsers,
                previousTokenPrices,
                previousBlock.beetsBar,
                previousBlock.beetsBarUsers[0] ?? null,
            );

            const swapFees = parseFloat(snapshot.totalSwapFee) - parseFloat(previousSnapshot.totalSwapFee);
            const myFees = swapFees * userPercentShare;

            if (userNumShares > 0) {
                userPoolData.push({
                    id: pool.id,
                    poolId: pool.id,
                    poolAddress: pool.address,
                    name: pool.name || '',
                    shares: userNumShares,
                    percentShare: userPercentShare,
                    totalValue: userTotalValue,
                    pricePerShare: userTotalValue / userNumShares,
                    tokens: userTokens.map((token) => ({
                        ...token,
                        percentOfPortfolio: token.totalValue / userTotalValue,
                    })),
                    swapFees,
                    swapVolume: parseFloat(snapshot.totalSwapVolume) - parseFloat(previousSnapshot.totalSwapVolume),
                    myFees: myFees > 0 ? myFees : 0,
                    priceChange:
                        pricePerShare && previous.pricePerShare
                            ? userNumShares * pricePerShare - userNumShares * previous.pricePerShare
                            : 0,
                    priceChangePercent:
                        pricePerShare && previous.pricePerShare
                            ? (pricePerShare - previous.pricePerShare) / pricePerShare
                            : 0,
                });
            }
        }

        const totalValue = _.sumBy(userPoolData, 'totalValue');

        return _.orderBy(userPoolData, 'totalValue', 'desc').map((pool) => ({
            ...pool,
            percentOfPortfolio: pool.totalValue / totalValue,
        }));
    }

    private mapPoolTokenToUserPoolTokenData(
        snapshot: PrismaBalancerPoolTokenSnapshotWithToken,
        percentShare: number,
        tokenPrices: TokenPrices,
    ): Omit<UserTokenData, 'percentOfPortfolio'> {
        const token = snapshot.token;
        const pricePerToken = tokenPrices[token.address.toLowerCase()]?.usd || 0;
        const balance = parseFloat(snapshot.balance) * percentShare;

        return {
            id: snapshot.id,
            address: token.address,
            symbol: balancerTokenMappings.tokenSymbolOverwrites[token.symbol] || token.symbol,
            name: token.name,
            pricePerToken,
            balance,
            totalValue: pricePerToken * balance,
        };
    }

    private tokensFromUserPoolData(data: UserPoolData[]): UserTokenData[] {
        const allTokens = _.flatten(data.map((item) => item.tokens));
        const groupedTokens = _.groupBy(allTokens, 'symbol');
        const poolsTotalValue = _.sumBy(data, 'totalValue');

        const tokens = _.map(groupedTokens, (group) => {
            const totalValue = _.sumBy(group, (token) => token.totalValue);

            return {
                ...group[0],
                balance: _.sumBy(group, (token) => token.balance),
                totalValue,
                percentOfPortfolio: totalValue / poolsTotalValue,
            };
        });

        return _.orderBy(tokens, 'totalValue', 'desc');
    }

    private sumJoinExits(
        joinExits: BalancerJoinExitFragment[],
        tokenPrices: TokenPrices,
    ): { token: string; balance: number; totalValue: number }[] {
        const tokensWithAmounts = _.flatten(
            joinExits.map((joinExit) =>
                joinExit.amounts.map((amount, idx) => ({
                    amount,
                    token: joinExit.pool.tokensList[idx],
                    type: joinExit.type,
                })),
            ),
        );

        const grouped = _.groupBy(tokensWithAmounts, 'token');

        return _.map(grouped, (token, address) => {
            const balance = _.sumBy(
                token,
                (item) => parseFloat(item.amount) * (item.type === InvestType.Exit ? -1 : 1),
            );
            const pricePerToken = tokenPrices[address.toLowerCase()]?.usd || 0;

            return {
                token: address,
                balance,
                totalValue: balance * pricePerToken,
            };
        });
    }

    private generatePoolIntermediates(
        pool: PrismaBalancerPool,
        snapshot: PrismaBalancerPoolSnapshotWithTokens,
        poolShares: PrismaBalancerPoolShareSnapshot[],
        userFarms: PrismaFarmUserSnapshotWithFarm[],
        tokenPrices: TokenPrices,
        beetsBar: PrismaBeetsBarSnapshot | null,
        beetsBarUser: PrismaBeetsBarUserSnapshot | null,
    ) {
        const beetsBarSharesForPool = this.getUserBeetsBarSharesForPool(pool, userFarms, beetsBar, beetsBarUser);
        const poolShare = poolShares.find((shares) => shares.poolId === pool.id);
        const userFarm = userFarms.find((userFarm) => userFarm.farm.pair === pool.address);
        const userNumShares =
            parseFloat(poolShare?.balance || '0') +
            fromFp(BigNumber.from(userFarm?.amount || 0)).toNumber() +
            beetsBarSharesForPool;
        const poolTotalShares = parseFloat(snapshot.totalShares);
        const poolTotalValue = this.getPoolValue(snapshot, tokenPrices);
        const userPercentShare = userNumShares / poolTotalShares;
        const userTokens = _.orderBy(
            (snapshot.tokens || []).map((snapshot) =>
                this.mapPoolTokenToUserPoolTokenData(snapshot, userPercentShare, tokenPrices),
            ),
            'totalValue',
            'desc',
        );
        const userTotalValue = _.sumBy(userTokens, (token) => token.totalValue);

        return {
            userNumShares,
            userPercentShare,
            userTokens,
            userTotalValue,
            pricePerShare: poolTotalValue / poolTotalShares,
            poolTotalValue,
            poolTotalShares,
        };
    }

    private getUserBeetsBarSharesForPool(
        pool: PrismaBalancerPool,
        userFarms: PrismaFarmUserSnapshotWithFarm[],
        beetsBar: PrismaBeetsBarSnapshot | null,
        beetsBarUser: PrismaBeetsBarUserSnapshot | null,
    ): number {
        if (pool.id !== env.FBEETS_POOL_ID || !beetsBar) {
            return 0;
        }

        const userFbeetsFarm = userFarms.find((userFarm) => userFarm.farm.pair === env.FBEETS_ADDRESS);
        const userStakedFbeets = fromFp(userFbeetsFarm?.amount || '0').toNumber();
        const userFbeets = parseFloat(beetsBarUser?.fBeets || '0');

        return (userStakedFbeets + userFbeets) * parseFloat(beetsBar.ratio);
    }

    private getPoolValue(pool: PrismaBalancerPoolSnapshotWithTokens, tokenPrices: TokenPrices): number {
        return _.sum(
            (pool.tokens || []).map((token) => parseFloat(token.balance) * (tokenPrices[token.address]?.usd || 0)),
        );
    }

    public mapPortfolioDataToGql(data: UserPortfolioData): GqlUserPortfolioData {
        return {
            ...data,
            totalValue: `${data.totalValue}`,
            totalSwapFees: `${data.totalSwapFees}`,
            totalSwapVolume: `${data.totalSwapVolume}`,
            myFees: `${data.myFees}`,
            pools: data.pools.map((pool) => ({
                ...pool,
                totalValue: `${pool.totalValue}`,
                swapFees: `${pool.swapFees}`,
                swapVolume: `${pool.swapVolume}`,
                myFees: `${pool.myFees}`,
                priceChange: `${pool.priceChange}`,
                pricePerShare: `${pool.pricePerShare}`,
                shares: `${pool.shares}`,
                tokens: pool.tokens.map((token) => this.mapUserTokenDataToGql(token)),
            })),
            tokens: data.tokens.map((token) => this.mapUserTokenDataToGql(token)),
        };
    }

    private mapUserTokenDataToGql(token: UserTokenData): GqlUserTokenData {
        return {
            ...token,
            balance: `${token.balance}`,
            pricePerToken: `${token.pricePerToken}`,
            totalValue: `${token.totalValue}`,
        };
    }
}

export const portfolioService = new PortfolioService();
