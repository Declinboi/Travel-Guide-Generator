-- ============================================
-- Database Migration for Book Generation App
-- PostgreSQL + TypeORM Entities
-- ============================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- 1. USERS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255),
    password VARCHAR(255) NOT NULL,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_users_email ON users(email);

-- ============================================
-- 2. PROJECTS TABLE
-- ============================================
CREATE TYPE project_status AS ENUM ('DRAFT', 'GENERATING_CONTENT', 'TRANSLATING', 'GENERATING_DOCUMENTS', 'COMPLETED', 'FAILED');

CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(255) NOT NULL,
    subtitle VARCHAR(255),
    author VARCHAR(255) NOT NULL,
    description TEXT,
    status project_status DEFAULT 'DRAFT',
    "numberOfChapters" INTEGER DEFAULT 10,
    "contentLength" VARCHAR(50) DEFAULT 'MEDIUM',
    "userId" UUID,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_project_user FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_projects_user ON projects("userId");
CREATE INDEX idx_projects_status ON projects(status);

-- ============================================
-- 3. CHAPTERS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS chapters (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(255) NOT NULL,
    "order" INTEGER NOT NULL,
    content TEXT NOT NULL,
    "projectId" UUID NOT NULL,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_chapter_project FOREIGN KEY ("projectId") REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT unique_project_chapter_order UNIQUE ("projectId", "order")
);

CREATE INDEX idx_chapters_project ON chapters("projectId");
CREATE INDEX idx_chapters_order ON chapters("order");

-- ============================================
-- 4. IMAGES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS images (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    filename VARCHAR(255) NOT NULL,
    "originalName" VARCHAR(255) NOT NULL,
    "mimeType" VARCHAR(100) NOT NULL,
    size INTEGER NOT NULL,
    url VARCHAR(512) NOT NULL,
    "storageKey" VARCHAR(512) NOT NULL,
    position INTEGER,
    caption TEXT,
    "chapterNumber" INTEGER,
    "isMap" BOOLEAN DEFAULT FALSE,
    "projectId" UUID NOT NULL,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_image_project FOREIGN KEY ("projectId") REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX idx_images_project ON images("projectId");
CREATE INDEX idx_images_chapter ON images("chapterNumber");

-- ============================================
-- 5. TRANSLATIONS TABLE
-- ============================================
CREATE TYPE language AS ENUM ('ENGLISH', 'GERMAN', 'FRENCH', 'SPANISH', 'ITALIAN');
CREATE TYPE translation_status AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED');

CREATE TABLE IF NOT EXISTS translations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    language language NOT NULL,
    title VARCHAR(255) NOT NULL,
    subtitle VARCHAR(255),
    content JSON NOT NULL,
    status translation_status DEFAULT 'PENDING',
    "projectId" UUID NOT NULL,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP,
    CONSTRAINT fk_translation_project FOREIGN KEY ("projectId") REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT unique_project_language UNIQUE ("projectId", language)
);

CREATE INDEX idx_translations_project ON translations("projectId");
CREATE INDEX idx_translations_status ON translations(status);

-- ============================================
-- 6. DOCUMENTS TABLE
-- ============================================
CREATE TYPE document_type AS ENUM ('PDF', 'DOCX');
CREATE TYPE document_status AS ENUM ('PENDING', 'GENERATING', 'COMPLETED', 'FAILED');

CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type document_type NOT NULL,
    language language NOT NULL,
    filename VARCHAR(255) NOT NULL,
    url VARCHAR(512) NOT NULL,
    "storageKey" VARCHAR(512) NOT NULL,
    size INTEGER,
    status document_status DEFAULT 'PENDING',
    "projectId" UUID NOT NULL,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP,
    CONSTRAINT fk_document_project FOREIGN KEY ("projectId") REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT unique_project_type_language UNIQUE ("projectId", type, language)
);

CREATE INDEX idx_documents_project ON documents("projectId");
CREATE INDEX idx_documents_status ON documents(status);

-- ============================================
-- 7. JOBS TABLE
-- ============================================
CREATE TYPE job_type AS ENUM ('CONTENT_GENERATION', 'TRANSLATION', 'PDF_GENERATION', 'DOCX_GENERATION', 'IMAGE_PROCESSING');
CREATE TYPE job_status AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED');

CREATE TABLE IF NOT EXISTS jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type job_type NOT NULL,
    status job_status DEFAULT 'PENDING',
    data JSON,
    result JSON,
    error TEXT,
    progress INTEGER DEFAULT 0,
    "projectId" UUID NOT NULL,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP,
    "completedAt" TIMESTAMP,
    CONSTRAINT fk_job_project FOREIGN KEY ("projectId") REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX idx_jobs_project ON jobs("projectId");
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_type ON jobs(type);

-- ============================================
-- TRIGGER: Auto-update updatedAt timestamp
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW."updatedAt" = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_projects_updated_at BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_chapters_updated_at BEFORE UPDATE ON chapters
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_translations_updated_at BEFORE UPDATE ON translations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- Verification Queries
-- ============================================
-- Run these to verify tables were created:
-- SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';
-- \dt (in psql)