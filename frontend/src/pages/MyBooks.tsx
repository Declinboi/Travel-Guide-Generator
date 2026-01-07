// src/pages/MyBooks.tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import axios from "axios";
import { useSelector } from "react-redux";
import { type RootState } from "../redux/store";

const MyBooks = () => {
  const { user } = useSelector((state: RootState) => state.auth);
  const [projects, setProjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchProjects = async () => {
      try {
        const response = await axios.get(
          `http://localhost:4000/api/projects?userId=${user?.id}`
        );
        setProjects(response.data);
        setLoading(false);
      } catch (error) {
        console.error("Error fetching projects:", error);
        setLoading(false);
      }
    };

    if (user?.id) {
      fetchProjects();
    }
  }, [user]);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-12">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading your books...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-12">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold">My Books</h1>
        <Link
          to="/create"
          className="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700"
        >
          + Create New Book
        </Link>
      </div>

      {projects.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-600 mb-4">
            You haven't created any books yet.
          </p>
          <Link
            to="/create"
            className="inline-block bg-blue-600 text-white px-6 py-3 rounded-md hover:bg-blue-700"
          >
            Create Your First Book
          </Link>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {projects.map((project) => (
            <div key={project.id} className="bg-white rounded-lg shadow-md p-6">
              <h3 className="text-xl font-semibold mb-2">{project.title}</h3>
              <p className="text-gray-600 mb-4">{project.subtitle}</p>

              <div className="flex items-center justify-between text-sm text-gray-500 mb-4">
                <span>
                  📅 {new Date(project.createdAt).toLocaleDateString()}
                </span>
                <span
                  className={`px-2 py-1 rounded ${
                    project.status === "COMPLETED"
                      ? "bg-green-100 text-green-800"
                      : project.status === "FAILED"
                      ? "bg-red-100 text-red-800"
                      : "bg-yellow-100 text-yellow-800"
                  }`}
                >
                  {project.status}
                </span>
              </div>

              <div className="flex space-x-2">
                {project.status === "COMPLETED" ? (
                  <Link
                    to={`/downloads/${project.id}`}
                    className="flex-1 bg-blue-600 text-white text-center px-4 py-2 rounded-md hover:bg-blue-700"
                  >
                    Download
                  </Link>
                ) : (
                  <Link
                    to={`/status/${project.id}`}
                    className="flex-1 bg-gray-600 text-white text-center px-4 py-2 rounded-md hover:bg-gray-700"
                  >
                    View Status
                  </Link>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default MyBooks;
