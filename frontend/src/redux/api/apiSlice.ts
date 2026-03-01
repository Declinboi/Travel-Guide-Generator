import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";
import type { BaseQueryFn } from "@reduxjs/toolkit/query";
import type { RootState } from "../store";

const baseQuery = fetchBaseQuery({
  baseUrl: "https://theodora-faraway-homily.ngrok-free.dev/api", //  http://localhost:4000/api
  credentials: "include",
  prepareHeaders: (headers, { getState }) => {
    // Try Redux state first, fallback to localStorage
    const token =
      (getState() as RootState).auth.token || localStorage.getItem("token");

    // Validate token is not null/undefined string
    if (token && token !== "null" && token !== "undefined") {
      headers.set("Authorization", `Bearer ${token}`); // ← FIXED: backticks were missing
    }

    headers.set("Cache-Control", "no-cache");
    headers.set("Pragma", "no-cache");
    return headers;
  },
});

// Wrapper to handle 401 errors
const baseQueryWithReauth: BaseQueryFn = async (args, api, extraOptions) => {
  const result = await baseQuery(args, api, extraOptions);

  if (result.error && result.error.status === 401) {
    // Clear invalid auth data
    localStorage.removeItem("token");
    localStorage.removeItem("userInfo");

    // Dispatch logout action
    api.dispatch({ type: "auth/logout" });

    // Redirect to login
    window.location.href = "/login";
  }

  return result;
};

export const apiSlice = createApi({
  baseQuery: baseQueryWithReauth, // ← Use the wrapper
  tagTypes: ["User", "Project"],
  keepUnusedDataFor: 0,
  refetchOnFocus: true,
  refetchOnReconnect: true,
  endpoints: (_builder) => ({}),
});
