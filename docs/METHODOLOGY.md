# Content Research Methodology

> Code references: fetch and store — `framework/adapters/xhs.py` + `framework/store.py`;
> collect-rate and quantitative analysis — `framework/analysis/quant.py`; comment sentiment — `framework/analysis/sentiment.py`;
> research workflow entry point — `SKILL.md`.

## 1. Why collect-rate is the signal on Xiaohongshu

The core difference between Xiaohongshu and YouTube or Douyin lies in **user intent and distribution logic**. Douyin and YouTube are built around immersive entertainment — a like signals an emotional reaction. Xiaohongshu is built around search and decision-making — **a save signals practical value and intent to return**.

- **The signal**: **collect-rate** (saves ÷ likes, or saves ÷ impressions) is the primary measure of content value.
- **What each metric means**:
  - **Like**: instant emotional feedback; drives short-term burst traffic.
  - **Save**: confirmation of practical value; drives **long-tail traffic** and **search ranking**.
- **The implication**: high collect-rate posts have longer lifespans, continue attracting traffic through search, and are the primary benchmark for research.

## 2. Five analysis dimensions

### 1. Collect-rate ranking
- **What to look at**: saves ÷ likes for each post.
- **How to read it**: saves ≈ or > likes → strong how-to / tutorial / checklist content, high practical value. Likes far exceed saves → emotional or aesthetic content, strong initial burst but weak long tail. **Benchmark against high collect-rate posts, not just high-like posts.**

### 2. Cover image
> 🚧 **Roadmap**: methodology defined; automated image analysis not yet implemented (currently a manual review guide).
- **What to look at**: visual elements in the feed thumbnail — text, faces, composition.
- **How to read it**: high-save covers typically feature large-type headlines, pain-point keywords, or data comparisons; real faces build trust; product shots or screenshots build clarity; consistent color tone, moderate information density, clear focal point.

### 3. Hashtag timing
- **What to look at**: publish-time distribution of posts under a given hashtag.
- **How to read it**: high-save posts concentrated recently → topic is rising, good entry window. High-save posts are old, recent posts perform poorly → topic is saturated. **Avoid mature viral hashtags; look for hashtags where new high-save posts are still appearing in the last month.**

### 4. Image posts vs videos
- **What to look at**: performance of each content format within the same niche.
- **How to read it**: image posts favor search retention; videos favor algorithmic reach. Tutorial and guide content gets higher save rates as image posts (easy to reference); experiential content gets better engagement as video. **If the top high-save posts in a niche are mostly image posts, don't pivot to video blindly.**

### 5. Paid-promotion detection
> 🚧 **Roadmap**: methodology defined; automated detection not yet implemented (currently a manual review guide).
- **What to look at**: ratio of engagement to follower count; growth curve shape.
- **How to read it**: low follower count but unusually high engagement per post with sparse comments, or a sharp spike followed by a cliff drop → likely paid promotion. Organic traffic grows gradually; comments are authentic and directly relevant to the content. **Filter out paid-promotion outliers to avoid mistaking bought reach for organic content performance.**

## 3. Three research scenarios

### 1. Evaluating a niche (should I enter?)
Look at the collect-rate distribution across the niche (low overall = weak practical value, poor long-tail) and the type of top-performing content (does it depend on strong personal brand or pure content quality — heavy IP dependency makes new entrants harder to break through).

### 2. Analyzing competitors (what makes them strong?)
Pull the competitor's **collect-rate** Top 5 posts (not like Top 5). Reverse-engineer their cover structure — font size, color palette, pain-point keywords — and their hashtag choices. Extract reusable templates.

### 3. Finding topics (what to write?)
Sort industry keywords by "most saves" to surface high-frequency sub-topics. Cross-reference with publish dates: prioritize topics that have produced high-save posts within the last month (rising traffic window).
