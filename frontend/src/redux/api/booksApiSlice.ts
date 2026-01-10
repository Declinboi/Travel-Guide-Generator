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
      invalidatesTags: [{ type: "Project", id: "LIST" }],
    }),

    getBookStatus: builder.query({
      query: (projectId: string) => `/books/status/${projectId}`,
      providesTags: (_result, _error, projectId) => [
        { type: "Project", id: projectId },
      ],
    }),

    getDownloadLinks: builder.query({
      query: (projectId: string) => `/books/download/${projectId}`,
      providesTags: (_result, _error, projectId) => [
        { type: "Project", id: projectId },
      ],
    }),
  }),
});

export const {
  useGenerateBookMutation,
  useGetBookStatusQuery,
  useGetDownloadLinksQuery,
} = booksApiSlice;
