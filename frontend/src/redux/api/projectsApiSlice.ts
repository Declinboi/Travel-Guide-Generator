// src/redux/api/projectsApiSlice.ts
import { apiSlice } from "./apiSlice";

export interface Project {
  id: string;
  title: string;
  subtitle?: string;
  author: string;
  status: string;
  numberOfChapters?: number;
  userId?: string;
  createdAt: string;
  updatedAt: string;
  images?: any[];
  chapters?: any[];
  translations?: any[];
  documents?: any[];
  jobs?: any[];
}

export interface ProjectStats {
  stats: {
    totalChapters: number;
    totalImages: number;
    completedTranslations: number;
    completedDocuments: number;
  };
}

export const projectsApiSlice = apiSlice.injectEndpoints({
  endpoints: (builder) => ({
    // Get all projects for a user
    getProjects: builder.query<
      Project[],
      { userId?: string; status?: string } | void
    >({
      query: (params) => {
        // If no params or no userId, just return /projects without query params
        if (!params || !params.userId) {
          return "/projects";
        }

        const queryParams = new URLSearchParams();
        if (params.userId) queryParams.append("userId", params.userId);
        if (params.status) queryParams.append("status", params.status);

        const queryString = queryParams.toString();
        return `/projects?${queryString}`;
      },
      providesTags: (result) =>
        result
          ? [
              ...result.map(({ id }) => ({ type: "Project" as const, id })),
              { type: "Project", id: "LIST" },
            ]
          : [{ type: "Project", id: "LIST" }],
    }),

    // Get single project by ID
    getProject: builder.query<Project, string>({
      query: (id) => `/projects/${id}`,
      providesTags: (_result, _error, id) => [{ type: "Project", id }],
    }),

    // Get project stats
    getProjectStats: builder.query<ProjectStats, string>({
      query: (id) => `/projects/${id}/stats`,
      providesTags: (_result, _error, id) => [{ type: "Project", id }],
    }),

    // Get project translations
    getProjectTranslations: builder.query<any[], string>({
      query: (id) => `/projects/${id}/translations`,
      providesTags: (_result, _error, id) => [{ type: "Project", id }],
    }),

    // Get project documents
    getProjectDocuments: builder.query<any[], string>({
      query: (id) => `/projects/${id}/documents`,
      providesTags: (_result, _error, id) => [{ type: "Project", id }],
    }),

    // Update project status
    updateProjectStatus: builder.mutation<
      Project,
      { id: string; status: string }
    >({
      query: ({ id, status }) => ({
        url: `/projects/${id}/status`,
        method: "PATCH",
        body: { status },
      }),
      invalidatesTags: (_result, _error, { id }) => [
        { type: "Project", id },
        { type: "Project", id: "LIST" },
      ],
    }),

    // Delete project
    deleteProject: builder.mutation<void, string>({
      query: (id) => ({
        url: `/projects/${id}`,
        method: "DELETE",
      }),
      invalidatesTags: (_result, _error, id) => [
        { type: "Project", id },
        { type: "Project", id: "LIST" },
      ],
    }),

    // Create project
    createProject: builder.mutation<
      Project,
      {
        title: string;
        subtitle?: string;
        author: string;
        numberOfChapters: number;
      }
    >({
      query: (body) => ({
        url: "/projects",
        method: "POST",
        body,
      }),
      invalidatesTags: [{ type: "Project", id: "LIST" }],
    }),
  }),
});

export const {
  useGetProjectsQuery,
  useGetProjectQuery,
  useGetProjectStatsQuery,
  useGetProjectTranslationsQuery,
  useGetProjectDocumentsQuery,
  useUpdateProjectStatusMutation,
  useDeleteProjectMutation,
  useCreateProjectMutation,
} = projectsApiSlice;
