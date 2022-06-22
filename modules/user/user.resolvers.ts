import { Resolvers } from '../../schema';
import { userService } from './user.service';
import { getRequiredAccountAddress, isAdminRoute } from '../util/resolver-util';

const resolvers: Resolvers = {
    Query: {
        userGetPoolBalances: async (parent, {}, context) => {
            const accountAddress = getRequiredAccountAddress(context);

            const balances = await userService.getUserPoolBalances(accountAddress);

            return balances.map((balance) => ({
                ...balance,
                id: balance.poolId,
            }));
        },
        userGetFbeetsBalance: async (parent, {}, context) => {
            const accountAddress = getRequiredAccountAddress(context);

            const balance = await userService.getUserFbeetsBalance(accountAddress);

            return {
                id: balance.tokenAddress,
                ...balance,
            };
        },
    },
    Mutation: {
        userSyncWalletBalancesForAllPools: async (parent, {}, context) => {
            isAdminRoute(context);

            await userService.initWalletBalancesForAllPools();

            return 'success';
        },
        userInitWalletBalancesForAllPools: async (parent, {}, context) => {
            isAdminRoute(context);

            await userService.initWalletBalancesForAllPools();

            return 'success';
        },
        userInitWalletBalancesForPool: async (parent, { poolId }, context) => {
            isAdminRoute(context);

            await userService.initWalletBalancesForPool(poolId);

            return 'success';
        },
        userInitStakedBalances: async (parent, {}, context) => {
            isAdminRoute(context);

            await userService.initStakedBalances();

            return 'success';
        },
        userSyncStakedBalances: async (parent, {}, context) => {
            isAdminRoute(context);

            await userService.syncStakedBalances();

            return 'success';
        },
    },
};

export default resolvers;
