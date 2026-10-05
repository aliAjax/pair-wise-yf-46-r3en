import { configureStore } from "@reduxjs/toolkit";
import rundownReducer from "./rundownSlice";
import scheduleReducer, { SCHEDULE_STORAGE_KEY } from "./scheduleSlice";
import { rundownApi } from "./api";

export const store = configureStore({
  reducer: {
    rundown: rundownReducer,
    schedule: scheduleReducer,
    [rundownApi.reducerPath]: rundownApi.reducer
  },
  middleware: (getDefault) => getDefault().concat(rundownApi.middleware)
});

store.subscribe(() => {
  try {
    localStorage.setItem(SCHEDULE_STORAGE_KEY, JSON.stringify(store.getState().schedule));
  } catch {
    /* 持久化失败不影响播出 */
  }
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
