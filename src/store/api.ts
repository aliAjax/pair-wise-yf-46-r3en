import { createApi, fakeBaseQuery } from "@reduxjs/toolkit/query/react";
import type { ChannelState, Publish, RundownItem } from "../types";

const KEY = "pair-wise-yf-46/rundown";
const VERSION = 2;

export interface PersistedEnvelope {
  version: number;
  items: RundownItem[];
  publishes: Publish[];
  channels: ChannelState[];
}

type LoadResult =
  | { legacy: true; items: RundownItem[] }
  | { legacy: false; items: RundownItem[]; publishes: Publish[]; channels: ChannelState[] }
  | { legacy: true; items: [] };

export const rundownApi = createApi({
  reducerPath: "rundownApi",
  baseQuery: fakeBaseQuery(),
  tagTypes: ["Rundown"],
  endpoints: (builder) => ({
    getRundown: builder.query<LoadResult, void>({
      queryFn: async () => {
        const raw = localStorage.getItem(KEY);
        if (!raw) return { data: { legacy: true, items: [] } };
        const parsed = JSON.parse(raw) as PersistedEnvelope | RundownItem[];
        // 旧数据：裸数组、没有版本号 -> 交由 slice 按发布时间回填初始版本
        if (Array.isArray(parsed) || !("version" in parsed)) {
          return { data: { legacy: true, items: Array.isArray(parsed) ? parsed : [] } };
        }
        return {
          data: { legacy: false, items: parsed.items, publishes: parsed.publishes, channels: parsed.channels }
        };
      },
      providesTags: ["Rundown"]
    }),
    saveRundown: builder.mutation<{ ok: true }, PersistedEnvelope>({
      queryFn: async (envelope) => {
        localStorage.setItem(KEY, JSON.stringify(envelope));
        return { data: { ok: true } };
      },
      invalidatesTags: ["Rundown"]
    })
  })
});

export const PERSIST_VERSION = VERSION;
export const { useGetRundownQuery, useSaveRundownMutation } = rundownApi;
