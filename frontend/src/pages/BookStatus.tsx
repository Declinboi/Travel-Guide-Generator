// src/pages/BookStatus.tsx
import { useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
// import axios from "axios";
import { useGetBookStatusQuery } from "../redux/api/booksApiSlice";

const BookStatus = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  // Use RTK Query hook with polling enabled
  const {
    data: status,
    isLoading,
    isError,
  } = useGetBookStatusQuery(projectId!, {
    pollingInterval: 5000, // Poll every 5 seconds
    skip: !projectId, // Skip query if no projectId
  });

  // Handle redirect when complete
  useEffect(() => {
    if (status?.isComplete) {
      const timer = setTimeout(() => {
        navigate(`/downloads/${projectId}`);
      }, 2000);

      return () => clearTimeout(timer);
    }
  }, [status?.isComplete, navigate, projectId]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-xl">Loading status...</div>
      </div>
    );
  }

  if (isError || !status) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-xl text-red-600">
          ❌ Error loading status. Please try again.
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-12">
      <h1 className="text-3xl font-bold mb-8">Generation Progress</h1>

      <div className="bg-white rounded-lg shadow-md p-8">
        <div className="mb-6">
          <h2 className="text-xl font-semibold mb-2">{status.title}</h2>
          <p className="text-gray-600">by {status.author}</p>
        </div>

        {/* Progress Bar */}
        <div className="mb-8">
          <div className="flex justify-between mb-2">
            <span className="text-sm font-medium">Overall Progress</span>
            <span className="text-sm font-medium">{status.progress}%</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-4">
            <div
              className="bg-blue-600 h-4 rounded-full transition-all duration-500"
              style={{ width: `${status.progress}%` }}
            ></div>
          </div>
          <p className="text-sm text-gray-600 mt-2">
            Estimated completion: {status.estimatedCompletion}
          </p>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <div className="bg-gray-50 p-4 rounded-lg">
            <p className="text-sm text-gray-600">Chapters</p>
            <p className="text-2xl font-bold">{status.stats.chapters}/10</p>
          </div>
          <div className="bg-gray-50 p-4 rounded-lg">
            <p className="text-sm text-gray-600">Images</p>
            <p className="text-2xl font-bold">{status.stats.images}</p>
          </div>
          <div className="bg-gray-50 p-4 rounded-lg">
            <p className="text-sm text-gray-600">Translations</p>
            <p className="text-2xl font-bold">{status.stats.translations}</p>
          </div>
          <div className="bg-gray-50 p-4 rounded-lg">
            <p className="text-sm text-gray-600">Documents</p>
            <p className="text-2xl font-bold">{status.stats.documents}</p>
          </div>
        </div>

        {/* Status Message */}
        {status.isComplete && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-4">
            <p className="text-green-800 font-semibold">
              ✅ Generation Complete! Redirecting to downloads...
            </p>
          </div>
        )}

        {status.hasFailed && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <p className="text-red-800 font-semibold">
              ❌ Generation failed. Please try again.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default BookStatus;
