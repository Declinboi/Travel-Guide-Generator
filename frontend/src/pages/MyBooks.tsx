// src/pages/MyBooks.tsx (Enhanced version with delete)
import { useState } from "react";
import { Link } from "react-router-dom";
import { useSelector } from "react-redux";
import { toast } from "react-toastify";
import { type RootState } from "../redux/store";
import {
  useGetProjectsQuery,
  useDeleteProjectMutation,
} from "../redux/api/projectsApiSlice";

const MyBooks = () => {
  const { user } = useSelector((state: RootState) => state.auth);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  // Validate user ID exists and is valid
  const hasValidUser = user?.id && typeof user.id === 'string' && user.id.length > 0;

  // Fetch projects
  const {
    data: projects = [],
    isLoading,
    isError,
    error,
  } = useGetProjectsQuery(
    hasValidUser ? { userId: user.id } : undefined,
    {
      skip: !hasValidUser,
    }
  );

  // Delete mutation
  const [deleteProject, { isLoading: isDeleting }] =
    useDeleteProjectMutation();

  const handleDelete = async (id: string) => {
    if (!window.confirm("Are you sure you want to delete this book?")) {
      return;
    }

    try {
      await deleteProject(id).unwrap();
      toast.success("Book deleted successfully");
      setDeleteId(null);
    } catch (err: any) {
      toast.error(err?.data?.message || "Failed to delete book");
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading your books...</p>
        </div>
      </div>
    );
  }

  // Show error if no valid user
  if (!hasValidUser) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-600 text-xl">⚠️ Authentication Required</p>
          <p className="text-gray-600 mt-2">Please log in to view your books</p>
          <Link
            to="/login"
            className="mt-4 inline-block bg-blue-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-blue-700 transition"
          >
            Go to Login
          </Link>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-600 text-xl">❌ Error loading books</p>
          <p className="text-gray-600 mt-2">
            {error && "data" in error
              ? (error.data as any)?.message || "Something went wrong"
              : "Please try again later"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-12">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold">My Books</h1>
          <p className="text-gray-600 mt-1">
            {projects.length} {projects.length === 1 ? "book" : "books"} created
          </p>
        </div>
        <Link
          to="/create"
          className="bg-blue-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-blue-700 transition"
        >
          + Create New Book
        </Link>
      </div>

      {projects.length === 0 ? (
        <div className="bg-white rounded-lg shadow-md p-12 text-center">
          <div className="max-w-md mx-auto">
            <h2 className="text-2xl font-semibold mb-4">No books yet</h2>
            <p className="text-gray-600 mb-8">
              You haven't created any books yet.
            </p>
            <Link
              to="/create"
              className="bg-blue-600 text-white px-8 py-3 rounded-lg font-semibold hover:bg-blue-700 transition inline-block"
            >
              Create Your First Book
            </Link>
          </div>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {projects.map((project) => (
            <div
              key={project.id}
              className="bg-white rounded-lg shadow-md overflow-hidden hover:shadow-lg transition relative"
            >
              {/* Delete button */}
              <button
                onClick={() => handleDelete(project.id)}
                disabled={isDeleting && deleteId === project.id}
                className="absolute top-4 right-4 text-red-500 hover:text-red-700 bg-white rounded-full p-2 shadow-md hover:shadow-lg transition"
                title="Delete book"
              >
                {isDeleting && deleteId === project.id ? (
                  <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                      fill="none"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                ) : (
                  <svg
                    className="h-5 w-5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                    />
                  </svg>
                )}
              </button>

              <div className="p-6">
                <h3 className="text-xl font-semibold mb-2 pr-8">
                  {project.title}
                </h3>
                <p className="text-gray-600 mb-4 line-clamp-2">
                  {project.subtitle}
                </p>

                <div className="flex items-center gap-4 text-sm text-gray-500 mb-4">
                  <span className="flex items-center">
                    📅 {new Date(project.createdAt).toLocaleDateString()}
                  </span>
                  <span
                    className={`px-3 py-1 rounded-full text-xs font-medium ${
                      project.status === "COMPLETED"
                        ? "bg-green-100 text-green-800"
                        : project.status === "IN_PROGRESS"
                        ? "bg-blue-100 text-blue-800"
                        : project.status === "FAILED"
                        ? "bg-red-100 text-red-800"
                        : "bg-gray-100 text-gray-800"
                    }`}
                  >
                    {project.status}
                  </span>
                </div>

                <div className="flex gap-3">
                  {project.status === "COMPLETED" ? (
                    <Link
                      to={`/downloads/${project.id}`}
                      className="flex-1 bg-green-600 text-white text-center py-2 px-4 rounded-lg font-medium hover:bg-green-700 transition"
                    >
                      Download
                    </Link>
                  ) : (
                    <Link
                      to={`/status/${project.id}`}
                      className="flex-1 bg-blue-600 text-white text-center py-2 px-4 rounded-lg font-medium hover:bg-blue-700 transition"
                    >
                      View Status
                    </Link>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default MyBooks;