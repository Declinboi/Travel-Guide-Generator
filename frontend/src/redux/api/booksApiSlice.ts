// src/redux/api/booksApiSlice.ts
import { apiSlice } from "./apiSlice";

export const booksApiSlice = apiSlice.injectEndpoints({
  endpoints: (builder) => ({
    generateBook: builder.mutation<{ projectId: string }, FormData>({
      query: (formData) => ({
        url: "/books/generate",
        method: "POST",
        body: formData,
      }),
    }),

    getBookStatus: builder.query({
      query: (projectId: string) => `/books/status/${projectId}`,
      //   pollingInterval: 5000,
    }),

    getDownloadLinks: builder.query({
      query: (projectId: string) => `/books/download/${projectId}`,
    }),
  }),
});

export const {
  useGenerateBookMutation,
  useGetBookStatusQuery,
  useGetDownloadLinksQuery,
} = booksApiSlice;
