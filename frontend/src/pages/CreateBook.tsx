// src/pages/CreateBook.tsx
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "react-toastify";
import { useGenerateBookMutation } from "../redux/api/booksApiSlice";

interface ImagePreview {
  file: File;
  preview: string;
}

const CreateBook = () => {
  const navigate = useNavigate();
  const [generateBook, { isLoading }] = useGenerateBookMutation();

  const [formData, setFormData] = useState({
    title: "",
    subtitle: "",
    author: "",
  });

  const [images, setImages] = useState<ImagePreview[]>([]);
  const [mapImage, setMapImage] = useState<ImagePreview | null>(null);

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);

    // Create preview URLs for each image
    const previews = files.map((file) => ({
      file,
      preview: URL.createObjectURL(file),
    }));

    setImages(previews);
  };

  const handleMapChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];

    if (file) {
      setMapImage({
        file,
        preview: URL.createObjectURL(file),
      });
    }
  };

  const removeImage = (index: number) => {
    setImages((prev) => {
      // Revoke the URL to free memory
      URL.revokeObjectURL(prev[index].preview);
      return prev.filter((_, i) => i !== index);
    });
  };

  const removeMapImage = () => {
    if (mapImage) {
      URL.revokeObjectURL(mapImage.preview);
      setMapImage(null);
    }
  };

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

    const fd = new FormData();
    fd.append("title", formData.title);
    fd.append("subtitle", formData.subtitle);
    fd.append("author", formData.author);

    images.forEach((img) => fd.append("images", img.file));
    if (mapImage) fd.append("mapImage", mapImage.file);

    try {
      const res = await generateBook(fd).unwrap();
      toast.success("Book generation started");

      // Clean up preview URLs
      images.forEach((img) => URL.revokeObjectURL(img.preview));
      if (mapImage) URL.revokeObjectURL(mapImage.preview);

      navigate(`/status/${res.projectId}`);
    } catch (err: any) {
      toast.error(err?.data?.message || "Generation failed");
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-12">
      <h1 className="text-3xl font-bold mb-8">Create Your Travel Guide</h1>

      <form
        onSubmit={handleSubmit}
        className="bg-white rounded-lg shadow-md p-8 space-y-6"
      >
        {/* Title */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Book Title *
          </label>
          <input
            type="text"
            value={formData.title}
            onChange={(e) =>
              setFormData({ ...formData, title: e.target.value })
            }
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
            onChange={(e) =>
              setFormData({ ...formData, subtitle: e.target.value })
            }
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
            onChange={(e) =>
              setFormData({ ...formData, author: e.target.value })
            }
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
            onChange={handleImageChange}
            className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
            required
          />
          {images.length > 0 && (
            <div className="mt-4">
              <p className="text-sm font-medium text-gray-700 mb-3">
                {images.length} images selected
              </p>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {images.map((img, index) => (
                  <div key={index} className="relative group">
                    <img
                      src={img.preview}
                      alt={`Preview ${index + 1}`}
                      className="w-full h-32 object-cover rounded-lg border-2 border-gray-200"
                    />
                    <button
                      type="button"
                      onClick={() => removeImage(index)}
                      className="absolute top-1 right-1 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      ×
                    </button>
                    <p className="text-xs text-gray-600 mt-1 truncate">
                      {img.file.name}
                    </p>
                  </div>
                ))}
              </div>
            </div>
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
            onChange={handleMapChange}
            className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
          />
          {mapImage && (
            <div className="mt-4">
              <div className="relative group inline-block">
                <img
                  src={mapImage.preview}
                  alt="Map preview"
                  className="w-full max-w-md h-48 object-cover rounded-lg border-2 border-gray-200"
                />
                <button
                  type="button"
                  onClick={removeMapImage}
                  className="absolute top-2 right-2 bg-red-500 text-white rounded-full w-8 h-8 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  ×
                </button>
              </div>
              <p className="text-sm text-gray-600 mt-2">{mapImage.file.name}</p>
            </div>
          )}
        </div>

        {/* Info Box */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <h3 className="font-semibold text-blue-900 mb-2">
            📝 What happens next?
          </h3>
          <ul className="text-sm text-blue-800 space-y-1">
            <li>• Your book will be generated in 10-15 minutes</li>
            <li>• 10 chapters will be created automatically</li>
            <li>• Images will be distributed across chapters</li>
            <li>• Book will be translated to 4 languages</li>
            <li>• You'll get 10 documents (PDF & DOCX in 5 languages)</li>
          </ul>
        </div>

        {/* Submit Button */}
        <button
          type="submit"
          disabled={isLoading}
          className="w-full bg-blue-600 text-white py-3 px-6 rounded-md font-semibold hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition"
        >
          {isLoading
            ? "Generating... This may take 10-15 minutes"
            : "Generate Book"}
        </button>
      </form>
    </div>
  );
};

export default CreateBook;
