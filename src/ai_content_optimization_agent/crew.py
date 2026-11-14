import os
from crewai import Agent, Crew, Process, Task
from crewai.project import CrewBase, agent, crew, task
from ai_content_optimization_agent.tools import TitleScraperTool
from llms.gemini_google_search_llm import GeminiWithGoogleSearch

try:
    # Available in crewai_tools releases shipping the Bright Data extras.
    from crewai_tools import BrightDataSearchTool
except ImportError:  # pragma: no cover - exercised only without the extras
    BrightDataSearchTool = None

# Read the LLM model from the envs
MODEL = os.getenv("MODEL")

# Title scraper: wraps the Bright Data web unlocker with retry handling and
# structured attempt records, and returns the plain-text title on success or
# raises a TitleScrapeError (URL + attempt count) on failure.
title_scraper_tool = TitleScraperTool()

# Initialize the required Bright Data SERP search tool. The unlocker itself is
# instantiated lazily inside TitleScraperTool, so no credentials are needed
# just to import this module.
serp_search_tool = BrightDataSearchTool() if BrightDataSearchTool is not None else None

@CrewBase
class AiContentOptimizationAgent:
    # Paths to the config files
    agents_config = "config/agents.yaml"
    tasks_config = "config/tasks.yaml"

    @agent
    def title_scraper_agent(self) -> Agent:
        return Agent(
            config=self.agents_config["title_scraper_agent"],
            tools=[title_scraper_tool],
            verbose=True,
            llm=MODEL,
        )

    @agent
    def query_fanout_researcher_agent(self) -> Agent:
        return Agent(
            config=self.agents_config["query_fanout_researcher_agent"],
            verbose=True,
            llm=GeminiWithGoogleSearch(MODEL),
        )

    @agent
    def main_query_extractor_agent(self) -> Agent:
        return Agent(
            config=self.agents_config["main_query_extractor_agent"],
            verbose=True,
            llm=MODEL,
        )

    @agent
    def ai_overview_retriever_agent(self) -> Agent:
        tools = [serp_search_tool] if serp_search_tool is not None else []
        return Agent(
            config=self.agents_config["ai_overview_retriever_agent"],
            tools=tools,
            verbose=True,
            llm=MODEL,
        )

    @agent
    def ai_content_optimizer_agent(self) -> Agent:
        return Agent(
            config=self.agents_config["ai_content_optimizer_agent"],
            verbose=True,
            llm=MODEL,
        )

    @agent
    def query_fanout_summarizer_agent(self) -> Agent:
        return Agent(
            config=self.agents_config["query_fanout_summarizer_agent"],
            verbose=True,
            llm=MODEL,
        )

    @task
    def scrape_title_task(self) -> Task:
        return Task(
            config=self.tasks_config["scrape_title_task"],
            agent=self.title_scraper_agent(),
            max_retries=3,
        )

    @task
    def google_search_task(self) -> Task:
        return Task(
            config=self.tasks_config["google_search_task"],
            context=[self.scrape_title_task()],
            agent=self.query_fanout_researcher_agent(),
            max_retries=3,
            markdown=True,
            output_file="output/query_fanout.md",
        )

    @task
    def main_query_extraction_task(self) -> Task:
        return Task(
            config=self.tasks_config["main_query_extraction_task"],
            context=[self.google_search_task()],
            agent=self.main_query_extractor_agent(),
        )

    @task
    def ai_overview_extraction_task(self) -> Task:
        return Task(
            config=self.tasks_config["ai_overview_extraction_task"],
            context=[self.main_query_extraction_task()],
            agent=self.ai_overview_retriever_agent(),
            max_retries=3,
            markdown=True,
            output_file="output/ai_overview.md",
        )

    @task
    def query_fanout_summarization_task(self) -> Task:
        return Task(
            config=self.tasks_config["query_fanout_summarization_task"],
            context=[self.google_search_task()],
            agent=self.query_fanout_summarizer_agent(),
            markdown=True,
            output_file="output/query_fanout_summary.md",
        )

    @task
    def compare_ai_overview_task(self) -> Task:
        return Task(
            config=self.tasks_config["compare_ai_overview_task"],
            context=[self.query_fanout_summarization_task(), self.ai_overview_extraction_task()],
            agent=self.ai_content_optimizer_agent(),
            max_retries=3,
            markdown=True,
            output_file="output/report.md",
        )

    @crew
    def crew(self) -> Crew:
        return Crew(
            agents=self.agents,
            tasks=self.tasks,
            process=Process.sequential,
            verbose=True,
        )

