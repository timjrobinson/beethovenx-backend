import * as Sentry from '@sentry/node';
import {
    balancerSubgraphService,
    BalancerSubgraphService,
} from '../../subgraphs/balancer-subgraph/balancer-subgraph.service';
import { prisma } from '../../../prisma/prisma-client';
import {
    BalancerPoolSnapshotFragment,
    OrderDirection,
    PoolSnapshot_OrderBy,
} from '../../subgraphs/balancer-subgraph/generated/balancer-subgraph-types';
import { GqlPoolSnapshotDataRange } from '../../../schema';
import moment from 'moment-timezone';
import _ from 'lodash';
import { PrismaPoolSnapshot } from '@prisma/client';
import { prismaBulkExecuteOperations } from '../../../prisma/prisma-util';
import { prismaPoolWithExpandedNesting } from '../../../prisma/prisma-types';
import { CoingeckoService } from '../../coingecko/coingecko.service';
import { TokenHistoricalPrices } from '../../../legacy/token-price/token-price-types';
import { blocksSubgraphService } from '../../subgraphs/blocks-subgraph/blocks-subgraph.service';
import { sleep } from '../../common/promise';

export class PoolSnapshotService {
    constructor(
        private readonly balancerSubgraphService: BalancerSubgraphService,
        private readonly coingeckoService: CoingeckoService,
    ) {}

    public async getSnapshotsForPool(poolId: string, range: GqlPoolSnapshotDataRange) {
        const timestamp = this.getTimestampForRange(range);

        return prisma.prismaPoolSnapshot.findMany({
            where: { poolId, timestamp: { gte: timestamp } },
            orderBy: { timestamp: 'asc' },
        });
    }

    public async getSnapshotForPool(poolId: string, timestamp: number) {
        return prisma.prismaPoolSnapshot.findUnique({
            where: { id: `${poolId}-${timestamp}` },
        });
    }

    public async getSnapshotsForAllPools(range: GqlPoolSnapshotDataRange) {
        const timestamp = this.getTimestampForRange(range);

        return prisma.prismaPoolSnapshot.findMany({
            where: {
                timestamp: { gte: timestamp },
                totalSharesNum: {
                    gt: 0.000000000001,
                },
                pool: {
                    categories: { none: { category: 'BLACK_LISTED' } },
                },
            },
            orderBy: { timestamp: 'asc' },
        });
    }

    /*
    Per default, this method syncs the snapshot from today and from yesterday (daysTosync=2). It is important to also sync the snapshot from
    yesterday in the cron-job to capture all the changes between when it last ran and midnight. 
    */
    public async syncLatestSnapshotsForAllPools(daysToSync = 2) {
        let operations: any[] = [];
        const oneDayAgoStartOfDay = moment()
            .utc()
            .startOf('day')
            .subtract(daysToSync - 1, 'days')
            .unix();

        // per default (daysToSync=2) returns snapshots from yesterday and today
        const allSnapshots = await this.balancerSubgraphService.getAllPoolSnapshots({
            where: { timestamp_gte: oneDayAgoStartOfDay },
            orderBy: PoolSnapshot_OrderBy.Timestamp,
            orderDirection: OrderDirection.Asc,
        });

        const latestSyncedSnapshots = await prisma.prismaPoolSnapshot.findMany({
            where: {
                timestamp: moment().utc().startOf('day').subtract(daysToSync, 'days').unix(),
            },
        });

        const poolIds = _.uniq(allSnapshots.map((snapshot) => snapshot.pool.id));

        for (const poolId of poolIds) {
            const snapshots = allSnapshots.filter((snapshot) => snapshot.pool.id === poolId);
            const latestSyncedSnapshot = latestSyncedSnapshots.find((snapshot) => snapshot.poolId === poolId);
            const startTotalSwapVolume = `${latestSyncedSnapshot?.totalSwapVolume || '0'}`;
            const startTotalSwapFee = `${latestSyncedSnapshot?.totalSwapFee || '0'}`;

            const poolOperations = snapshots.map((snapshot, index) => {
                const prevTotalSwapVolume = index === 0 ? startTotalSwapVolume : snapshots[index - 1].swapVolume;
                const prevTotalSwapFee = index === 0 ? startTotalSwapFee : snapshots[index - 1].swapFees;

                const data = this.getPrismaPoolSnapshotFromSubgraphData(
                    snapshot,
                    prevTotalSwapVolume,
                    prevTotalSwapFee,
                );

                return prisma.prismaPoolSnapshot.upsert({
                    where: { id: snapshot.id },
                    create: data,
                    update: data,
                });
            });
            operations.push(...poolOperations);
        }

        await prismaBulkExecuteOperations(operations, true);

        const poolsWithoutSnapshots = await prisma.prismaPool.findMany({
            where: { OR: [{ type: 'PHANTOM_STABLE' }, { tokens: { some: { nestedPoolId: { not: null } } } }] },
            include: { tokens: true },
        });

        for (const pool of poolsWithoutSnapshots) {
            if (pool.type !== 'LINEAR') {
                await this.createPoolSnapshotsForPoolsMissingSubgraphData(pool.id, daysToSync);
            }
        }
    }

    public async loadAllSnapshotsForPools(poolIds: string[]) {
        //assuming the pool does not have more than 5,000 snapshots, we should be ok.
        const allSnapshots = await this.balancerSubgraphService.getAllPoolSnapshots({
            where: { pool_in: poolIds },
            orderBy: PoolSnapshot_OrderBy.Timestamp,
            orderDirection: OrderDirection.Asc,
        });

        for (const poolId of poolIds) {
            const snapshots = allSnapshots.filter((snapshot) => snapshot.pool.id === poolId);

            await prisma.prismaPoolSnapshot.createMany({
                data: snapshots.map((snapshot, index) => {
                    let prevTotalSwapVolume = index === 0 ? '0' : snapshots[index - 1].swapVolume;
                    let prevTotalSwapFee = index === 0 ? '0' : snapshots[index - 1].swapFees;

                    return this.getPrismaPoolSnapshotFromSubgraphData(snapshot, prevTotalSwapVolume, prevTotalSwapFee);
                }),
                skipDuplicates: true,
            });
        }
    }

    public async createPoolSnapshotsForPoolsMissingSubgraphData(poolId: string, numDays = -1) {
        const pool = await prisma.prismaPool.findUniqueOrThrow({
            where: { id: poolId },
            include: prismaPoolWithExpandedNesting.include,
        });

        const startTimestamp =
            numDays >= 0 ? moment().utc().startOf('day').subtract(numDays, 'days').unix() : pool.createTime;

        if (numDays < 0) {
            numDays = moment().diff(moment.unix(startTimestamp), 'days');
        }

        if (pool.type === 'LINEAR') {
            throw new Error('Unsupported pool type');
        }

        const swaps = await balancerSubgraphService.getAllSwapsWithPaging({ where: { poolId }, startTimestamp });

        const tokenPriceMap: TokenHistoricalPrices = {};

        for (const token of pool.tokens) {
            if (token.address === pool.address) {
                continue;
            }

            if (token.nestedPoolId && token.nestedPool) {
                const snapshots = await prisma.prismaPoolSnapshot.findMany({ where: { poolId: token.nestedPoolId } });

                tokenPriceMap[token.address] = snapshots.map((snapshot) => ({
                    timestamp: snapshot.timestamp,
                    price: snapshot.sharePrice,
                }));
            } else {
                try {
                    tokenPriceMap[token.address] = await this.coingeckoService.getTokenHistoricalPrices(
                        token.address,
                        numDays,
                    );
                    await sleep(5000);
                } catch (error: any) {
                    // Sentry.captureException(error);
                    console.error(
                        `Error getting historical prices form coingecko, falling back to database`,
                        error.message,
                    );
                    tokenPriceMap[token.address] = await prisma.prismaTokenPrice.findMany({
                        where: { tokenAddress: token.address, timestamp: { gte: startTimestamp } },
                    });
                }
            }
        }

        const dailyBlocks = await blocksSubgraphService.getDailyBlocks(numDays);

        for (const block of dailyBlocks) {
            const startTimestamp = parseInt(block.timestamp);
            const endTimestamp = startTimestamp + 86400;
            const swapsForDay = swaps.filter(
                (swap) =>
                    swap.timestamp >= startTimestamp &&
                    swap.timestamp < endTimestamp &&
                    swap.tokenIn !== pool.address &&
                    swap.tokenOut !== pool.address,
            );

            const volume24h = _.sumBy(swapsForDay, (swap) => {
                const prices = this.getTokenPricesForTimestamp(swap.timestamp, tokenPriceMap);
                let valueUsd = 0;

                if (prices[swap.tokenIn]) {
                    valueUsd = prices[swap.tokenIn] * parseFloat(swap.tokenAmountIn);
                } else if (prices[swap.tokenOut]) {
                    valueUsd = prices[swap.tokenOut] * parseFloat(swap.tokenAmountOut);
                }

                return valueUsd;
            });

            const { pool: poolAtBlock } = await this.balancerSubgraphService.getPool({
                id: poolId,
                block: { number: parseInt(block.number) },
            });

            if (!poolAtBlock) {
                console.log(
                    `pool does not exist at block. Pool id: ${poolId}, block: ${block.number}, skipping block...`,
                );
                continue;
            }

            const tokenPrices = this.getTokenPricesForTimestamp(endTimestamp, tokenPriceMap);
            const totalLiquidity = _.sumBy(
                poolAtBlock.tokens || [],
                (token) => parseFloat(token.balance) * (tokenPrices[token.address] || 0),
            );
            const totalShares = parseFloat(poolAtBlock.totalShares);

            const id = `${poolId}-${startTimestamp}`;
            const data = {
                id,
                poolId,
                timestamp: startTimestamp,
                totalLiquidity: totalLiquidity || 0,
                totalShares: poolAtBlock.totalShares,
                totalSharesNum: totalShares,
                swapsCount: parseInt(poolAtBlock.swapsCount),
                holdersCount: parseInt(poolAtBlock.holdersCount),
                amounts: (poolAtBlock.tokens || []).map((token) => token.balance),
                volume24h,
                fees24h: volume24h * parseFloat(poolAtBlock.swapFee),
                sharePrice: totalLiquidity > 0 && totalShares > 0 ? totalLiquidity / totalShares : 0,

                //TODO: these are always 0 at the moment
                totalSwapVolume: parseFloat(poolAtBlock.totalSwapVolume),
                totalSwapFee: parseFloat(poolAtBlock.totalSwapFee),
            };

            try {
                await prisma.prismaPoolSnapshot.upsert({ where: { id }, create: data, update: data });
            } catch (e) {
                console.log('pool snapshot upsert for ' + id, data);
                throw e;
            }
        }
    }

    private getPrismaPoolSnapshotFromSubgraphData(
        snapshot: BalancerPoolSnapshotFragment,
        prevTotalSwapVolume: string,
        prevTotalSwapFee: string,
    ): PrismaPoolSnapshot {
        const totalLiquidity = parseFloat(snapshot.liquidity);
        const totalShares = parseFloat(snapshot.totalShares);

        return {
            id: snapshot.id,
            poolId: snapshot.pool.id,
            timestamp: snapshot.timestamp,
            totalLiquidity: parseFloat(snapshot.liquidity),
            totalShares: snapshot.totalShares,
            totalSharesNum: parseFloat(snapshot.totalShares),
            totalSwapVolume: parseFloat(snapshot.swapVolume),
            totalSwapFee: parseFloat(snapshot.swapFees),
            swapsCount: parseInt(snapshot.swapsCount),
            holdersCount: parseInt(snapshot.holdersCount),
            amounts: snapshot.amounts,
            volume24h: Math.max(parseFloat(snapshot.swapVolume) - parseFloat(prevTotalSwapVolume), 0),
            fees24h: Math.max(parseFloat(snapshot.swapFees) - parseFloat(prevTotalSwapFee), 0),
            sharePrice: totalLiquidity > 0 && totalShares > 0 ? totalLiquidity / totalShares : 0,
        };
    }

    private getTimestampForRange(range: GqlPoolSnapshotDataRange): number {
        switch (range) {
            case 'THIRTY_DAYS':
                return moment().startOf('day').subtract(30, 'days').unix();
            case 'NINETY_DAYS':
                return moment().startOf('day').subtract(90, 'days').unix();
            case 'ONE_HUNDRED_EIGHTY_DAYS':
                return moment().startOf('day').subtract(180, 'days').unix();
            case 'ONE_YEAR':
                return moment().startOf('day').subtract(365, 'days').unix();
            case 'ALL_TIME':
                return 0;
        }
    }

    public getTokenPricesForTimestamp(
        timestamp: number,
        tokenHistoricalPrices: TokenHistoricalPrices,
    ): { [address: string]: number } {
        const msTimestamp = timestamp * 1000;
        return _.mapValues(tokenHistoricalPrices, (tokenPrices) => {
            if (tokenPrices.length === 0) {
                return 0;
            }

            const closest = tokenPrices.reduce((a, b) => {
                return Math.abs(b.timestamp - msTimestamp) < Math.abs(a.timestamp - msTimestamp) ? b : a;
            });

            return closest.price;
        });
    }
}
