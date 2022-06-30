import { memCacheGetValue, memCacheSetValue } from '../util/mem-cache';
import { sanityClient } from '../util/sanity';
import { env } from '../../app/env';
import { ConfigHomeScreen } from './config-types';

const HOME_SCREEN_CONFIG_CACHE_KEY = 'config:homeScreen';

export class ConfigService {
    public async getHomeScreenConfig(): Promise<ConfigHomeScreen> {
        const cached = memCacheGetValue<ConfigHomeScreen>(HOME_SCREEN_CONFIG_CACHE_KEY);

        if (cached) {
            return cached;
        }

        const data = await sanityClient.fetch<ConfigHomeScreen | null>(`
            *[_type == "homeScreen" && chainId == ${env.CHAIN_ID}][0]{
                ...,
                "featuredPoolGroups": featuredPoolGroups[]{
                    ...,
                    "icon": icon.asset->url + "?w=64",
                    "items": items[]{
                        ...,
                        "image": image.asset->url + "?w=600"
                    }
                }
            }
        `);

        if (!data) {
            throw new Error(`No home screen config found for chain id ${env.CHAIN_ID}`);
        }

        memCacheSetValue(HOME_SCREEN_CONFIG_CACHE_KEY, data, 60 * 5);

        return data;
    }
}

export const configService = new ConfigService();