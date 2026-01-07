// src/pages/CreateBook.tsx
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "react-toastify";
import axios from "axios";

const CreateBook = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    title: "",
    subtitle: "",
    author: "",
  });
  const [images, setImages] = useState<File[]>([]);
  const [mapImage, setMapImage] = useState<File | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.title || !formData.author) {
      toast.error("Title and Author are required");
      return;
    }

    if (images.length < 5) {
      toast.error("Please upload at least 5 images");
      return;
    }

    setLoading(true);

    try {
      const formDataToSend = new FormData();
      formDataToSend.append("title", formData.title);
      formDataToSend.append("subtitle", formData.subtitle);
      formDataToSend.append("author", formData.author);

      images.forEach((image) => {
        formDataToSend.append("images", image);
      });

      if (mapImage) {
        formDataToSend.append("mapImage", mapImage);
      }

      const response = await axios.post(
        "http://localhost:4000/api/books/generate",
        formDataToSend,
        {
          headers: {
            "Content-Type": "multipart/form-data",
          },
        }
      );

      toast.success("Book generation started!");
      navigate(`/status/${response.data.projectId}`);
    } catch (error: any) {
      toast.error(error.response?.data?.message || "Failed to start generation");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-12">
      <h1 className="text-3xl font-bold mb-8">Create Your Travel Guide</h1>

      <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow-md p-8 space-y-6">
        {/* Title */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Book Title *
          </label>
          <input
            type="text"
            value={formData.title}
            onChange={(e) => setFormData({ ...formData, title: e.target.value })}
            className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
            placeholder="e.g., Asturias Travel Guide 2026"
            required
          />
        </div>

        {/* Subtitle */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Subtitle (Optional)
          </label>
          <input
            type="text"
            value={formData.subtitle}
            onChange={(e) => setFormData({ ...formData, subtitle: e.target.value })}
            className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
            placeholder="e.g., From Gijón to the Picos de Europa..."
          />
        </div>

        {/* Author */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Author Name *
          </label>
          <input
            type="text"
            value={formData.author}
            onChange={(e) => setFormData({ ...formData, author: e.target.value })}
            className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
            placeholder="e.g., John Smith"
            required
          />
        </div>

        {/* Chapter Images */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Chapter Images (5-20 images) *
          </label>
          <input
            type="file"
            multiple
            accept="image/*"
            onChange={(e) => setImages(Array.from(e.target.files || []))}
            className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
            required
          />
          {images.length > 0 && (
            <p className="text-sm text-gray-600 mt-2">{images.length} images selected</p>
          )}
        </div>

        {/* Map Image */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Map Image (Optional - for last page)
          </label>
          <input
            type="file"
            accept="image/*"
            onChange={(e) => setMapImage(e.target.files?.[0] || null)}
            className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
          />
          {mapImage && (
            <p className="text-sm text-gray-600 mt-2">{mapImage.name}</p>
          )}
        </div>

        {/* Submit Button */}
        <button
          type="submit"
          disabled={loading}
          className="w-full bg-blue-600 text-white py-3 px-6 rounded-md font-semibold hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition"
        >
          {loading ? "Generating... This may take 10-15 minutes" : "Generate Book"}
        </button>
      </form>
    </div>
  );
};

export default CreateBook;