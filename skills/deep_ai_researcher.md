# Skill: Deep AI Researcher
**Expertise**: AI Engineering, Large Language Models (LLMs), Fine-Tuning, Reinforcement Learning (RL), and RAG.
**Maintained by**: Liya (Powered by Orchestra Research)

## 🎯 When to Use
- Any request involving **Fine-tuning** (Unsloth, Axolotl, LLaMA-Factory).
- Questions about **Model Architecture** (MoE, Attention, Quantization).
- Deep dives into **Reinforcement Learning** (GRPO, PPO, DPO, RLHF).
- Complex **RAG (Retrieval Augmented Generation)** optimization (FAISS, ChromaDB, Hybrid Search).
- Scientific **AI Research** paper summaries or implementation guides.

## 🛠️ Core Patterns

### 1. Fast Fine-Tuning (Unsloth Pattern)
Use this for ultra-fast training with minimal memory.
```python
from unsloth import FastLanguageModel
import torch

model, tokenizer = FastLanguageModel.from_pretrained(
    model_name = "unsloth/llama-3-8b-bnb-4bit",
    max_seq_length = 2048,
    load_in_4bit = True,
)

# Add LoRA adapters
model = FastLanguageModel.get_peft_model(
    model,
    r = 16,
    target_modules = ["q_proj", "k_proj", "v_proj", "o_proj"],
    lora_alpha = 16,
    lora_dropout = 0,
    bias = "none",
)
```

### 2. Reinforcement Learning (GRPO Pattern)
Used for training models to reason (like DeepSeek-R1).
- **Goal**: Optimize for logic and correctness without a reward model.
- **Key Config**: Group size (G), KL Divergence penalty, and Reward functions.

### 3. Advanced RAG (Hybrid Search)
```python
# Combine Semantic (Vector) + Keyword (BM25)
results = vector_db.similarity_search(query)
keyword_results = bm25.get_top_k(query)
final_ranking = reciprocal_rank_fusion(results, keyword_results)
```

## 🚀 Research Execution Protocol
1. **Understand Goal**: Identify if it's SFT (Supervised Fine-Tuning), DPO, or simple RAG.
2. **Select Framework**: Favor Unsloth for speed, vLLM for serving.
3. **Draft Architecture**: Professional, production-ready code only.
4. **Backgrounding**: For complex research, advise Navraj that "I am running this in the background" using the `spawn` tool.

---
*Note: This skill integrates knowledge from Orchestra Research (85+ specialized AI Engineering skills).*
