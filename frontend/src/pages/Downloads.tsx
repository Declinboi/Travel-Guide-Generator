// src/pages/Downloads.tsx
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import axios from "axios";

const Downloads = () => {
  const { projectId } = useParams();
  const [downloads, setDownloads] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchDownloads = async () => {
      try {
        const response = await axios.get(
          `http://localhost:4000/api/books/download/${projectId}`
        );
        setDownloads(response.data);
        setLoading(false);
      } catch (error) {
        console.error("Error fetching downloads:", error);
        setLoading(false);
      }
    };

    fetchDownloads();
  }, [projectId]);

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-12">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading downloads...</p>
        </div>
      </div>
    );
  }

  const groupedDocuments = downloads.documents?.reduce((acc: any, doc: any) => {
    if (!acc[doc.language]) {
      acc[doc.language] = [];
    }
    acc[doc.language].push(doc);
    return acc;
  }, {});

  return (
    <div className="max-w-6xl mx-auto px-4 py-12">
      <h1 className="text-3xl font-bold mb-2">Your Books Are Ready!</h1>
      <p className="text-gray-600 mb-8">
        {downloads.totalDocuments} documents generated • Click to download
      </p>

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
        {Object.entries(groupedDocuments || {}).map(([language, docs]: any) => (
          <div key={language} className="bg-white rounded-lg shadow-md p-6">
            <h3 className="text-xl font-semibold mb-4 flex items-center">
              <span className="mr-2">🌍</span>
              {language}
            </h3>
            <div className="space-y-3">
              {docs.map((doc: any) => (
                <a
                  key={doc.id}
                  href={`http://localhost:4000${doc.downloadUrl}`}
                  className="flex items-center justify-between p-3 bg-gray-50 rounded hover:bg-gray-100 transition"
                >
                  <div className="flex items-center">
                    <span className="text-2xl mr-3">
                      {doc.type === "PDF" ? "📕" : "📘"}
                    </span>
                    <div>
                      <p className="font-medium">{doc.type}</p>
                      <p className="text-sm text-gray-600">{doc.size}</p>
                    </div>
                  </div>
                  <span className="text-blue-600">⬇️</span>
                </a>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default Downloads;
