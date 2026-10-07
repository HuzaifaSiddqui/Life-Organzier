# Life Organizer Architecture

## Stack

Frontend: React Native + Expo + TypeScript

Backend: Express + TypeScript

Database: PostgreSQL + Prisma ORM

AI: Ollama + Qwen 2.5 with deterministic rule-parser fallback

Speech: Expo speech recognition currently; Whisper can be added later

OCR: Tesseract planned for a future module

## Architecture Flow

Mobile App | REST API | Express Backend | PostgreSQL / Hybrid Parser /
Ollama / Local Notifications

## AI Flow

User Input -> Preprocessing -> Ollama semantic extraction -> Rule validation -> Clarity rules -> Task creation -> Reminder scheduling

## Rules

-   AI keys stay on backend.
-   Providers must be replaceable.
-   Chat and voice share the same task pipeline.
-   Ollama failure falls back to deterministic extraction.
