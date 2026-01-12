// src/pages/MyBooks.tsx (Fixed - Cache Busting Version)
import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useSelector } from "react-redux";
import { toast } from "react-toastify";
import { type RootState } from "../redux/store";
import {
  useGetProjectsQuery,
  useDeleteProjectMutation,
} from "../redux/api/projectsApiSlice";
import { useGetBookStatusQuery } from "../redux/api/booksApiSlice";

const ProjectCard = ({ project, onDelete, isDeleting, deleteId }: any) => {
  const shouldPoll =
    project.status === "GENERATING_CONTENT" ||
    project.status === "TRANSLATING" ||
    project.status === "GENERATING_DOCUMENTS" ||
    project.status === "IN_PROGRESS";

  const { data: liveStatus } = useGetBookStatusQuery(project.id, {
    skip: !shouldPoll,
    pollingInterval: shouldPoll ? 5000 : 0,
    refetchOnMountOrArgChange: true,
  });

  // Use live status if available, otherwise use project status
  const currentStatus = liveStatus?.status || project.status;
  const progress = liveStatus?.progress ?? 0;

  return (
    <div className="bg-white rounded-lg shadow-md overflow-hidden hover:shadow-lg transition relative">
      <button
        onClick={() => onDelete(project.id)}
        disabled={isDeleting && deleteId === project.id}
        className="absolute top-4 right-4 text-red-500 hover:text-red-700 bg-white rounded-full p-2 shadow-md hover:shadow-lg transition z-10"
        title="Delete book"
      >
        {isDeleting && deleteId === project.id ? (
          <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
        ) : (
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        )}
      </button>

      <div className="p-6">
        <h3 className="text-xl font-semibold mb-2 pr-8">{project.title}</h3>
        <p className="text-gray-600 mb-4 line-clamp-2">{project.subtitle || "No subtitle"}</p>

        <div className="flex items-center gap-4 text-sm text-gray-500 mb-4">
          <span className="flex items-center">📅 {new Date(project.createdAt).toLocaleDateString()}</span>
          <span className={`px-3 py-1 rounded-full text-xs font-medium ${
            currentStatus === "COMPLETED" ? "bg-green-100 text-green-800" :
            currentStatus === "IN_PROGRESS" || currentStatus === "GENERATING_CONTENT" || currentStatus === "TRANSLATING" || currentStatus === "GENERATING_DOCUMENTS" ? "bg-blue-100 text-blue-800" :
            currentStatus === "FAILED" ? "bg-red-100 text-red-800" :
            currentStatus === "DRAFT" ? "bg-yellow-100 text-yellow-800" : "bg-gray-100 text-gray-800"
          }`}>
            {shouldPoll && <span className="inline-block w-2 h-2 bg-blue-600 rounded-full mr-1 animate-pulse"></span>}
            {currentStatus.replace(/_/g, " ")}
          </span>
        </div>

        {shouldPoll && liveStatus && (
          <div className="mb-4">
            <div className="flex justify-between text-xs text-gray-600 mb-1">
              <span>Progress</span>
              <span>{progress}%</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div className="bg-blue-600 h-2 rounded-full transition-all duration-500" style={{ width: `${progress}%` }}></div>
            </div>
            {liveStatus.estimatedCompletion && (
              <p className="text-xs text-gray-500 mt-1">Est. {liveStatus.estimatedCompletion}</p>
            )}
          </div>
        )}

        <div className="flex gap-3">
          {currentStatus === "COMPLETED" ? (
            <Link to={`/downloads/${project.id}`} className="flex-1 bg-green-600 text-white text-center py-2 px-4 rounded-lg font-medium hover:bg-green-700 transition">
              📥 Download
            </Link>
          ) : shouldPoll ? (
            <Link to={`/status/${project.id}`} className="flex-1 bg-blue-600 text-white text-center py-2 px-4 rounded-lg font-medium hover:bg-blue-700 transition">
              ⏳ View Progress
            </Link>
          ) : currentStatus === "FAILED" ? (
            <Link to={`/status/${project.id}`} className="flex-1 bg-red-600 text-white text-center py-2 px-4 rounded-lg font-medium hover:bg-red-700 transition">
              ❌ View Error
            </Link>
          ) : (
            <Link to={`/status/${project.id}`} className="flex-1 bg-gray-600 text-white text-center py-2 px-4 rounded-lg font-medium hover:bg-gray-700 transition">
              👁️ View Details
            </Link>
          )}
        </div>
      </div>
    </div>
  );
};

const MyBooks = () => {
  const { user } = useSelector((state: RootState) => state.auth);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const hasValidUser = user?.id && typeof user.id === "string" && user.id.length > 0;

  const {
    data: projects = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useGetProjectsQuery(
    hasValidUser ? { userId: user.id } : undefined,
    {
      skip: !hasValidUser,
      pollingInterval: 10000,
      refetchOnMountOrArgChange: true,
      // CRITICAL FIX: Force refetch to bypass cache
      refetchOnFocus: true,
      refetchOnReconnect: true,
    }
  );

  // Force initial refetch when component mounts
  useEffect(() => {
    if (hasValidUser) {
      console.log("🔄 Force refetching projects...");
      refetch();
    }
  }, [hasValidUser]);

  useEffect(() => {
    console.log("📊 Projects loaded:", projects?.length || 0);
    if (projects?.length > 0) {
      console.log("Projects:", projects);
    }
  }, [projects]);

  const [deleteProject, { isLoading: isDeleting }] = useDeleteProjectMutation();

  const handleDelete = async (id: string) => {
    if (!window.confirm("Are you sure you want to delete this book?")) return;

    try {
      setDeleteId(id);
      await deleteProject(id).unwrap();
      toast.success("Book deleted successfully");
      setDeleteId(null);
      refetch();
    } catch (err: any) {
      toast.error(err?.data?.message || "Failed to delete book");
      setDeleteId(null);
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

  if (!hasValidUser) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="bg-white rounded-lg shadow-lg p-8 max-w-md">
          <p className="text-red-600 text-xl mb-4">⚠️ Authentication Required</p>
          <p className="text-gray-600 mb-6">Please log in to view your books</p>
          <Link to="/login" className="block w-full bg-blue-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-blue-700 transition text-center">
            Go to Login
          </Link>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="bg-white rounded-lg shadow-lg p-8 max-w-md">
          <p className="text-red-600 text-xl mb-4">❌ Error loading books</p>
          <p className="text-gray-600 mb-6">
            {error && "data" in error
              ? (error.data as any)?.message || "Something went wrong"
              : "Please try again later"}
          </p>
          <button onClick={() => refetch()} className="w-full bg-blue-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-blue-700 transition">
            Try Again
          </button>
        </div>
      </div>
    );
  }

  const hasInProgressProjects = projects.some(
    (p) => p.status === "IN_PROGRESS" || p.status === "GENERATING_CONTENT" || 
           p.status === "TRANSLATING" || p.status === "GENERATING_DOCUMENTS"
  );

  return (
    <div className="max-w-7xl mx-auto px-4 py-12">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold">My Books</h1>
          <p className="text-gray-600 mt-1">
            {projects.length} {projects.length === 1 ? "book" : "books"} created
            {hasInProgressProjects && (
              <span className="ml-3 inline-flex items-center text-sm text-blue-600">
                <span className="animate-pulse mr-1">●</span>
                Live updates enabled
              </span>
            )}
          </p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => refetch()}
            className="bg-gray-600 text-white px-4 py-3 rounded-lg font-semibold hover:bg-gray-700 transition flex items-center gap-2"
            title="Refresh projects list"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
          <Link to="/create" className="bg-blue-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-blue-700 transition">
            + Create New Book
          </Link>
        </div>
      </div>

      {projects.length === 0 ? (
        <div className="bg-white rounded-lg shadow-md p-12 text-center">
          <div className="max-w-md mx-auto">
            <h2 className="text-2xl font-semibold mb-4">No books yet</h2>
            <p className="text-gray-600 mb-8">You haven't created any books yet.</p>
            <Link to="/create" className="bg-blue-600 text-white px-8 py-3 rounded-lg font-semibold hover:bg-blue-700 transition inline-block">
              Create Your First Book
            </Link>
          </div>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} onDelete={handleDelete} isDeleting={isDeleting} deleteId={deleteId} />
          ))}
        </div>
      )}
    </div>
  );
};

export default MyBooks;