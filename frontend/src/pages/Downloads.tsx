// src/pages/Downloads.tsx
import { useParams } from "react-router-dom";
import { useGetDownloadLinksQuery } from "../redux/api/booksApiSlice";
import { useMemo } from "react";

interface Document {
  id: string;
  type: string;
  language: string;
  downloadUrl: string;
  size: string;
}

interface DownloadsData {
  totalDocuments: number;
  documents: Document[];
}

const Downloads = () => {
  const { projectId } = useParams<{ projectId: string }>();

  const {
    data: downloads,
    isLoading,
    isError,
  } = useGetDownloadLinksQuery(projectId!, {
    skip: !projectId,
  }) as {
    data: DownloadsData | undefined;
    isLoading: boolean;
    isError: boolean;
  };

  // Group documents by language using useMemo for performance
  const groupedDocuments = useMemo(() => {
    if (!downloads?.documents) return {};

    return downloads.documents.reduce(
      (acc: Record<string, Document[]>, doc: Document) => {
        if (!acc[doc.language]) {
          acc[doc.language] = [];
        }
        acc[doc.language].push(doc);
        return acc;
      },
      {}
    );
  }, [downloads?.documents]);

  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-12">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading downloads...</p>
        </div>
      </div>
    );
  }

  if (isError || !downloads) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-12">
        <div className="text-center">
          <p className="text-red-600 text-xl">❌ Error loading downloads</p>
          <p className="text-gray-600 mt-2">Please try again later</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-12">
      <h1 className="text-3xl font-bold mb-2">Your Books Are Ready!</h1>
      <p className="text-gray-600 mb-8">
        {downloads.totalDocuments} documents generated • Click to download
      </p>

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
        {Object.entries(groupedDocuments).map(([language, docs]) => (
          <div key={language} className="bg-white rounded-lg shadow-md p-6">
            <h3 className="text-xl font-semibold mb-4 flex items-center">
              <span className="mr-2">🌍</span>
              {language}
            </h3>
            <div className="space-y-3">
              {(docs as Document[]).map((doc: Document) => (
                <a
                  key={doc.id}
                  href={`http://localhost:4000${doc.downloadUrl}`}
                  className="flex items-center justify-between p-3 bg-gray-50 rounded hover:bg-gray-100 transition"
                  download
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
