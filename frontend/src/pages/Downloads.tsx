import { useParams } from "react-router-dom";
import { useGetDownloadLinksQuery } from "../redux/api/booksApiSlice";
import { useMemo } from "react";

interface Document {
  id: string;
  filename: string;
  type: string;
  language: string;
  url: string; // Cloudinary URL
  size: string;
  createdAt: string;
}

// interface DownloadsData {
//   projectId: string;
//   title: string;
//   totalDocuments: number;
//   documents: Document[];
// }

const Downloads = () => {
  const { projectId } = useParams<{ projectId: string }>();

  const {
    data: downloads,
    isLoading,
    isError,
  } = useGetDownloadLinksQuery(projectId!, {
    skip: !projectId,
  });

  // Group documents by language
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

  /**
   * Handle download with proper filename
   */
  const handleDownload = async (doc: Document) => {
    try {
      // Option 1: Direct download using fetch
      const response = await fetch(doc.url);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);

      const link = document.createElement("a");
      link.href = url;
      link.download = doc.filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Download failed:", error);
      // Fallback: Open in new tab
      window.open(doc.url, "_blank");
    }
  };

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

  if (downloads.totalDocuments === 0) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-12">
        <div className="text-center">
          <p className="text-yellow-600 text-xl">
            ⏳ Documents are still being generated
          </p>
          <p className="text-gray-600 mt-2">
            Please check back in a few minutes
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-12">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">
          📚 {downloads.title || "Your Books Are Ready!"}
        </h1>
        <p className="text-gray-600">
          {downloads.totalDocuments} documents available • Stored securely on
          Cloudinary
        </p>
      </div>

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
        {Object.entries(groupedDocuments).map(([language, docs]) => (
          <div
            key={language}
            className="bg-white rounded-lg shadow-md p-6 hover:shadow-lg transition"
          >
            <h3 className="text-xl font-semibold mb-4 flex items-center">
              <span className="mr-2">🌍</span>
              {language.charAt(0).toUpperCase() +
                language.slice(1).toLowerCase()}
            </h3>

            <div className="space-y-3">
              {(docs as Document[]).map((doc: Document) => (
                <button
                  key={doc.id}
                  onClick={() => handleDownload(doc)}
                  className="w-full flex items-center justify-between p-3 bg-gray-50 rounded hover:bg-blue-50 transition cursor-pointer border border-transparent hover:border-blue-300"
                >
                  <div className="flex items-center text-left">
                    <span className="text-2xl mr-3">
                      {doc.type === "PDF" ? "📕" : "📘"}
                    </span>
                    <div>
                      <p className="font-medium">{doc.type}</p>
                      <p className="text-sm text-gray-600">{doc.size}</p>
                    </div>
                  </div>
                  <span className="text-blue-600 text-xl">⬇️</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 p-4 bg-blue-50 rounded-lg">
        <p className="text-sm text-gray-600">
          💡 <strong>Tip:</strong> All documents are stored securely on
          Cloudinary. Click any document to download it to your device.
        </p>
      </div>
    </div>
  );
};

export default Downloads;

// // ============================================
// // ALTERNATIVE: Simpler Download (Direct Link)
// // ============================================

// // If you prefer simpler approach, just use direct links:

// const Downloads = () => {
//   // ... same setup code ...

//   return (
//     <div className="max-w-6xl mx-auto px-4 py-12">
//       <h1 className="text-3xl font-bold mb-8">
//         📚 {downloads.title || 'Your Books Are Ready!'}
//       </h1>

//       <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
//         {Object.entries(groupedDocuments).map(([language, docs]) => (
//           <div key={language} className="bg-white rounded-lg shadow-md p-6">
//             <h3 className="text-xl font-semibold mb-4">
//               🌍 {language}
//             </h3>

//             <div className="space-y-3">
//               {(docs as Document[]).map((doc: Document) => (
//                 <a
//                   key={doc.id}
//                   href={doc.url}
//                   download={doc.filename}
//                   target="_blank"
//                   rel="noopener noreferrer"
//                   className="flex items-center justify-between p-3 bg-gray-50 rounded hover:bg-blue-50 transition"
//                 >
//                   <div className="flex items-center">
//                     <span className="text-2xl mr-3">
//                       {doc.type === "PDF" ? "📕" : "📘"}
//                     </span>
//                     <div>
//                       <p className="font-medium">{doc.type}</p>
//                       <p className="text-sm text-gray-600">{doc.size}</p>
//                     </div>
//                   </div>
//                   <span className="text-blue-600">⬇️</span>
//                 </a>
//               ))}
//             </div>
//           </div>
//         ))}
//       </div>
//     </div>
//   );
// };
