import { Link } from "react-router-dom";

const Home = () => {
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      {/* Hero Section */}
      <div className="text-center mb-16">
        <h1 className="text-5xl font-bold text-gray-900 mb-4">
          Create Professional Travel Guides in Minutes
        </h1>
        <p className="text-xl text-gray-600 mb-8">
          AI-powered content generation • Multi-language support • Professional formatting
        </p>
        <Link
          to="/create"
          className="inline-block bg-blue-600 text-white px-8 py-4 rounded-lg text-lg font-semibold hover:bg-blue-700 transition"
        >
          Get Started
        </Link>
      </div>

      {/* Features */}
      <div className="grid md:grid-cols-3 gap-8 mb-16">
        <div className="bg-white p-6 rounded-lg shadow-md">
          <div className="text-4xl mb-4">✍️</div>
          <h3 className="text-xl font-semibold mb-2">AI Content Generation</h3>
          <p className="text-gray-600">
            Automatically generates 10 chapters of engaging travel content
          </p>
        </div>

        <div className="bg-white p-6 rounded-lg shadow-md">
          <div className="text-4xl mb-4">🌍</div>
          <h3 className="text-xl font-semibold mb-2">5 Languages</h3>
          <p className="text-gray-600">
            English, German, French, Spanish, and Italian translations
          </p>
        </div>

        <div className="bg-white p-6 rounded-lg shadow-md">
          <div className="text-4xl mb-4">📄</div>
          <h3 className="text-xl font-semibold mb-2">PDF & DOCX</h3>
          <p className="text-gray-600">
            Professional 6×9 inch formatted documents ready for print
          </p>
        </div>
      </div>

      {/* How It Works */}
      <div className="bg-white rounded-lg shadow-md p-8">
        <h2 className="text-3xl font-bold text-center mb-8">How It Works</h2>
        <div className="grid md:grid-cols-4 gap-6">
          <div className="text-center">
            <div className="bg-blue-100 rounded-full w-12 h-12 flex items-center justify-center mx-auto mb-4">
              <span className="text-blue-600 font-bold">1</span>
            </div>
            <h4 className="font-semibold mb-2">Enter Details</h4>
            <p className="text-sm text-gray-600">Title, subtitle, author</p>
          </div>

          <div className="text-center">
            <div className="bg-blue-100 rounded-full w-12 h-12 flex items-center justify-center mx-auto mb-4">
              <span className="text-blue-600 font-bold">2</span>
            </div>
            <h4 className="font-semibold mb-2">Upload Images</h4>
            <p className="text-sm text-gray-600">10-12 photos + map</p>
          </div>

          <div className="text-center">
            <div className="bg-blue-100 rounded-full w-12 h-12 flex items-center justify-center mx-auto mb-4">
              <span className="text-blue-600 font-bold">3</span>
            </div>
            <h4 className="font-semibold mb-2">Generate</h4>
            <p className="text-sm text-gray-600">AI creates your book</p>
          </div>

          <div className="text-center">
            <div className="bg-blue-100 rounded-full w-12 h-12 flex items-center justify-center mx-auto mb-4">
              <span className="text-blue-600 font-bold">4</span>
            </div>
            <h4 className="font-semibold mb-2">Download</h4>
            <p className="text-sm text-gray-600">10 formatted books</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Home;