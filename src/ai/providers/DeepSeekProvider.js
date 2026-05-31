// src/ai/providers/DeepSeekProvider.js
import { httpClient } from "../../utils/httpClient.js";

const res = await httpClient.post(
  "https://api.deepseek.com/v1/chat/completions",
  { model: "deepseek-chat", messages: [
      {
        role: "system",
        content: "Du bist ein Coding Assistent"
      },
      {
        role: "user",
        content: "Schreibe eine REST API in Express"
      }
    ], },
  { headers: { Authorization: `Bearer ${apiKey}` } }
);