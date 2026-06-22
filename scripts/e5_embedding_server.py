#!/usr/bin/env python3
"""Small local OpenAI-compatible embedding server for multilingual-e5-base."""

from __future__ import annotations

import os
import time
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer


DEFAULT_MODEL = "intfloat/multilingual-e5-base"
MODEL_NAME = os.environ.get("E5_MODEL", DEFAULT_MODEL)
HOST = os.environ.get("E5_HOST", "127.0.0.1")
PORT = int(os.environ.get("E5_PORT", "8080"))

app = FastAPI(title="ZAIA E5 Embedding Server")
model: SentenceTransformer | None = None


class EmbeddingRequest(BaseModel):
  input: str | list[str]
  model: str | None = None
  encoding_format: str | None = None


class NativeEmbedRequest(BaseModel):
  inputs: str | list[str]


@app.on_event("startup")
def load_model() -> None:
  global model
  model = SentenceTransformer(MODEL_NAME)


@app.get("/health")
def health() -> dict[str, str]:
  return {"status": "ok", "model": MODEL_NAME}


@app.post("/v1/embeddings")
def create_embeddings(request: EmbeddingRequest) -> dict[str, Any]:
  inputs = normalize_inputs(request.input)
  embeddings = encode(inputs)

  return {
    "object": "list",
    "data": [
      {
        "object": "embedding",
        "embedding": embedding,
        "index": index,
      }
      for index, embedding in enumerate(embeddings)
    ],
    "model": request.model or MODEL_NAME,
    "usage": {
      "prompt_tokens": 0,
      "total_tokens": 0,
    },
  }


@app.post("/embed")
def native_embed(request: NativeEmbedRequest) -> list[list[float]] | list[float]:
  inputs = normalize_inputs(request.inputs)
  embeddings = encode(inputs)
  return embeddings[0] if isinstance(request.inputs, str) else embeddings


def normalize_inputs(value: str | list[str]) -> list[str]:
  if isinstance(value, str):
    value = [value]

  inputs = [entry.strip() for entry in value if isinstance(entry, str)]
  if not inputs:
    raise HTTPException(status_code=400, detail="No embedding input provided")

  return inputs


def encode(inputs: list[str]) -> list[list[float]]:
  if model is None:
    raise HTTPException(status_code=503, detail="Embedding model is loading")

  embeddings = model.encode(
    inputs,
    batch_size=16,
    normalize_embeddings=True,
    show_progress_bar=False,
  )
  return embeddings.tolist()


if __name__ == "__main__":
  started_at = time.strftime("%Y-%m-%d %H:%M:%S")
  print(f"Starting {MODEL_NAME} on http://{HOST}:{PORT} at {started_at}")
  uvicorn.run(app, host=HOST, port=PORT)
