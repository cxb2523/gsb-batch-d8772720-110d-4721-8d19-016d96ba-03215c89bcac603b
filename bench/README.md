# Searcharvester benchmarks

Мини-харнесс для проверки качества `/research` на открытых датасетах.

## SimpleQA-20

**Источник:** [OpenAI SimpleQA](https://openai.com/index/introducing-simpleqa/) через [basicv8vc/SimpleQA](https://huggingface.co/datasets/basicv8vc/SimpleQA) на Hugging Face.

Подборка из 20 вопросов, стратифицированная по `topic` и `answer_type`, чтобы не перекосить в одну категорию (Art, Music, Geography, Politics, Science and technology, Sports и т.д.).

### Запуск

```bash
python3 bench/run_simpleqa.py \
    --adapter http://localhost:8000 \
    --dataset bench/simpleqa_20.jsonl \
    --output bench/results.jsonl \
    --parallel 1
```

Параметры:
- `--parallel N` — сколько задач запускать одновременно (каждая поднимает свой эфемерный Hermes-контейнер)
- `--per-job-timeout 600` — лимит на одну задачу в секундах
- `--poll-interval 5` — частота опроса `/research/{id}`

### Грейдинг

**Substring-match нормализованного ответа в отчёте** (NFKD-unicode, lowercase, удаление пунктуации, два и больше подряд идущих токенов gold-ответа в отчёте тоже считаются correct). Не идеальный, но консервативный: пропускает «правильный ответ с другой формулировкой», но не штрафует за незначительные различия типа пунктуации.

### Известные ограничения SimpleQA для нашего кейса

- Ответы — часто **коротенькие имена/даты/числа**, а deep-research это скорее «синтез многих источников». SimpleQA хорошо ловит «агент вообще умеет найти факт в вебе?», но не «агент умеет писать хорошие research-отчёты».
- Substring-матчинг **ненадёжен** для numeric-ответов (даты с разным форматированием, округления).
- Для обширной оценки лучше **[DeepResearch Bench](https://deepresearch-bench.github.io/)** (LLM-as-judge по их методичке).

### Что дальше

- Async-параллельный прогон (5+ задач одновременно) — переключаешь `--parallel 5` и смотришь throughput.
- Добавить LLM-as-judge грейдинг (помимо substring) для SimpleQA.
- Прикрутить DeepResearch Bench (~100 complex queries) с их официальным грейдером.
