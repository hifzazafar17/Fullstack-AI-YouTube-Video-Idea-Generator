"use server";

import { auth } from "@clerk/nextjs/server";
import { db } from "@/server/db/drizzle";
import { eq, and, desc, inArray } from "drizzle-orm";
import {
  Videos,
  VideoComments,
  Ideas,
  InsertIdea,
  Idea,
  InsertCrewJob,
  CrewJobs,
} from "@/server/db/schema";
import { IdeaDetails } from "@/components/IdeaList";

// Define an interface for the idea object
interface IdeaData {
  video_id: string;
  comment_id: string;
  score?: number;
  description: string;
  video_title: string;
  research?: { url: string }[];
}

// Define a type for the research object
interface Research {
  url: string;
}

export async function kickoffIdeaGeneration(): Promise<void> {
  const { userId } = await auth();

  if (!userId) {
    throw new Error("User not authenticated");
  }

  console.log("Fetching latest 50 unused comments for user:", userId);

  // Fetch the latest 50 unused comments
  const comments = await db
    .select({
      title: Videos.title,
      comment: VideoComments.commentText,
      video_id: Videos.id,
      comment_id: VideoComments.id,
    })
    .from(VideoComments)
    .innerJoin(Videos, eq(VideoComments.videoId, Videos.id))
    .where(
      and(eq(VideoComments.userId, userId), eq(VideoComments.isUsed, false))
    )
    .orderBy(VideoComments.createdAt)
    .limit(50);

  console.log("Fetched comments:", comments);

  if (comments.length === 0) {
    throw new Error("No unused comments found to generate ideas");
  }

  const commentsString = JSON.stringify(comments);
  console.log("Formatted comments:", commentsString);

  const usedCommentIds = comments.map((comment) => comment.comment_id);

  await db
    .update(VideoComments)
    .set({ isUsed: true, updatedAt: new Date() })
    .where(
      and(
        eq(VideoComments.userId, userId),
        inArray(VideoComments.id, usedCommentIds)
      )
    );

  // Prepare request payload
  const payload = {
    inputs: { comments: commentsString },
  };

  try {
    console.log(
      "Sending POST request to CrewAI /kickoff endpoint with payload:",
      payload
    );

    // Send POST request to CrewAI /kickoff endpoint
    const kickoffResponse = await fetch(`${process.env.CREWAI_URL}/kickoff`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.CREWAI_BEARER_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });

    console.log("Received response from CrewAI /kickoff:", kickoffResponse);

    if (!kickoffResponse.ok) {
      throw new Error("Failed to initiate job with CrewAI");
    }

    const kickoffData = await kickoffResponse.json();
    console.log("Kickoff data received:", kickoffData);

    const kickoffId = kickoffData.kickoff_id;

    // Store the kickoff_id in the CrewJobs table
    const newJob: InsertCrewJob = {
      userId,
      kickoffId,
      jobState: "STARTED",
    };

    await db.insert(CrewJobs).values(newJob);
    console.log("New job inserted into CrewJobs table:", newJob);
  } catch (error) {
    console.error("Error initiating idea generation:", error);
    throw error;
  }
}

export async function processPendingJobs(): Promise<void> {
  const { userId } = await auth();

  if (!userId) {
    throw new Error("User not authenticated");
  }

  // Fetch pending or running jobs that have not been processed
  const pendingJobs = await db
    .select()
    .from(CrewJobs)
    .where(
      and(
        eq(CrewJobs.userId, userId),
        eq(CrewJobs.processed, false),
        inArray(CrewJobs.jobState, ["RUNNING", "STARTED", "PENDING"])
      )
    );

  if (pendingJobs.length === 0) {
    // No pending jobs to process
    return;
  }

  for (const job of pendingJobs) {
    try {
      // Poll the CrewAI /status/{kickoff_id} endpoint
      const statusResponse = await fetch(
        `${process.env.CREWAI_URL}/status/${job.kickoffId}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${process.env.CREWAI_BEARER_TOKEN}`,
          },
        }
      );

      if (!statusResponse.ok) {
        throw new Error(
          `Failed to fetch job status from CrewAI for job ${job.kickoffId}`
        );
      }

      const statusData = await statusResponse.json();
      const jobState = statusData.state;

      console.log("Received status data for job:", statusData);

      // Update the CrewJobs table with the latest job state
      await db
        .update(CrewJobs)
        .set({
          jobState: jobState,
          updatedAt: new Date(),
        })
        .where(eq(CrewJobs.id, job.id));

      if (jobState === "SUCCESS") {
        // Process the job result
        const jobResult = JSON.parse(statusData.result);
        console.log("Processing job result:", jobResult);

        // Update the CrewJobs table with the job result and processed flag
        await db
          .update(CrewJobs)
          .set({
            jobResult: JSON.stringify(jobResult),
            processed: true,
            updatedAt: new Date(),
          })
          .where(eq(CrewJobs.id, job.id));

        // Parse the ideas from the job result and insert into Ideas table
        const ideasData = jobResult;
        const newIdeas: InsertIdea[] = ideasData.map((idea: IdeaData) => ({
          userId,
          videoId: idea.video_id,
          commentId: idea.comment_id,
          score: idea.score || 0,
          videoTitle: idea.video_title,
          description: idea.description,
          research: idea.research
            ? idea.research.map((r: Research) => r.url)
            : [],
        }));

        await db.insert(Ideas).values(newIdeas);
      }
    } catch (error) {
      console.error(`Error processing job ${job.kickoffId}:`, error);
    }
  }
}

export async function checkForUnprocessedJobs(): Promise<boolean> {
  const { userId } = await auth();

  if (!userId) {
    throw new Error("User not authenticated");
  }

  // Fetch jobs that are not yet processed and are either running or pending
  const unprocessedJobs = await db
    .select()
    .from(CrewJobs)
    .where(
      and(
        eq(CrewJobs.userId, userId),
        eq(CrewJobs.processed, false),
        inArray(CrewJobs.jobState, ["RUNNING", "STARTED", "PENDING"])
      )
    );

  const hasUnprocessedJobs = unprocessedJobs.length > 0;
  return hasUnprocessedJobs;
}

export async function getNewIdeas(): Promise<Idea[]> {
  const { userId } = await auth();

  if (!userId) {
    throw new Error("User not authenticated");
  }

  const ideas = await db
    .select()
    .from(Ideas)
    .where(eq(Ideas.userId, userId))
    .orderBy(desc(Ideas.createdAt));

  return ideas;
}

export async function getIdeaDetails(
  videoId: string,
  commentId: string
): Promise<IdeaDetails> {
  const { userId } = await auth();

  if (!userId) {
    throw new Error("User not authenticated");
  }

  const [video] = await db
    .select({
      title: Videos.title,
    })
    .from(Videos)
    .where(eq(Videos.id, videoId));

  const [comment] = await db
    .select({
      commentText: VideoComments.commentText,
    })
    .from(VideoComments)
    .where(eq(VideoComments.id, commentId));

  return {
    videoTitle: video?.title || "Video not found",
    commentText: comment?.commentText || "Comment not found",
  };
}

/*
Example received status data for job:

{
  state: 'SUCCESS',
  status: null,
  result: '[\n' +
    '  {\n' +
    '    "score": 5,\n' +
    '    "video_title": "CrewAI Flows Crash Course: Do You Need to Subscribe for Codes?",\n' +
    '    "description": "In this video, we will address whether a subscription is necessary for accessing code snippets and features when using CrewAI. We will explore the different options available for users.",\n' +
    '    "video_id": "5cc8c8a8-544b-44ce-b08f-ef90551ebc2a",\n' +
    '    "comment_id": "9853d4e8-d21b-45c7-a6d6-1927f01aadad",\n' +
    '    "research": [\n' +
    '      {\n' +
    '        "title": "CrewAI Flows Crash Course",\n' +
    '        "url": "https://youtube.com/watch?v=8PtGcNE01yo",\n' +
    '        "view_count": 6534\n' +
    '      },\n' +
    '      {\n' +
    '        "title": "CrewAI Tutorial: Complete Crash Course for Beginners",\n' +
    '        "url": "https://youtube.com/watch?v=sPzc6hMg7So",\n' +
    '        "view_count": 195284\n' +
    '      },\n' +
    '      {\n' +
    '        "title": "LangGraph + CrewAI: Crash Course for Beginners [Source Code Included]",\n' +
    '        "url": "https://youtube.com/watch?v=5eYg1OcHm5k",\n' +
    '        "view_count": 31119\n' +
    '      },\n' +
    '      {\n' +
    '        "title": "CrewAI Tutorial for Beginners: Learn How To Use Latest CrewAI Features",\n' +
    '        "url": "https://youtube.com/watch?v=Jl6BuoXcZPE",\n' +
    '        "view_count": 78853\n' +
    '      },\n' +
    '      {\n' +
    '        "title": "crewAI Crash Course For Beginners-How To Create Multi AI Agent For Complex Usecases",\n' +
    '        "url": "https://youtube.com/watch?v=UV81LAb3x2g",\n' +
    '        "view_count": 42009\n' +
    '      }\n' +
    '    ]\n' +
    '  },\n' +
    '  {\n' +
    '    "score": 6,\n' +
    '    "video_title": "Improving UX for Plotting Multiple Chapters in CrewAI",\n' +
    '    "description": "This video discusses user experience improvements in CrewAI, particularly focusing on how to enhance the plotting of multiple chapters within a book. We will walk through some practical solutions.",\n' +
    '    "video_id": "5cc8c8a8-544b-44ce-b08f-ef90551ebc2a",\n' +
    '    "comment_id": "d492d1fc-14f2-4f51-bccb-b1963e908ec4",\n' +
    '    "research": [\n' +
    '      {\n' +
    '        "title": "How much does a SOFTWARE ENGINEER make?",\n' +
    '        "url": "https://youtube.com/watch?v=XkzPmtzdIEY",\n' +
    '        "view_count": 7062526\n' +
    '      },\n' +
    '      {\n' +
    '        "title": "7 Prompt Chains for Decision Making, Self Correcting, Reliable AI Agents",\n' +
    '        "url": "https://youtube.com/watch?v=QV6kaNFyoyQ",\n' +
    '        "view_count": 30288\n' +
    '      },\n' +
    '      {\n' +
    '        "title": "Build Anything with Perplexity, Here’s How",\n' +
    '        "url": "https://youtube.com/watch?v=w_YRnA8RdnU",\n' +
    '        "view_count": 220935\n' +
    '      },\n' +
    '      {\n' +
    '        "title": "15 INSANE Use Cases for NEW Claude Sonnet 3.5! (Outperforms GPT-4o)",\n' +
    '        "url": "https://youtube.com/watch?v=wBJZQt23J7M",\n' +
    '        "view_count": 226689\n' +
    '      },\n' +
    '      {\n' +
    '        "title": "How We Made That App Episode 7: Revolutionizing Language Models and Data Processing with LlamaIndex",\n' +
    '        "url": "https://youtube.com/watch?v=snpZI8LsESA",\n' +
    '        "view_count": 4183\n' +
    '      }\n' +
    '    ]\n' +
    '  },\n' +
    '  {\n' +
    '    "score": 8,\n' +
    '    "video_title": "Creating an Interactive Chatbot with Memory Using CrewAI",\n' +
    '    "description": "Join us as we develop an interactive chatbot using CrewAI. This video will cover how to implement memory features and maintain an engaging conversation flow throughout user interactions.",\n' +
    '    "video_id": "5cc8c8a8-544b-44ce-b08f-ef90551ebc2a",\n' +
    '    "comment_id": "2289d021-aebf-4c5a-900b-d40bf10e8642",\n' +
    '    "research": [\n' +
    '      {\n' +
    '        "title": "The RIGHT WAY To Build AI Agents with CrewAI (BONUS: 100% Local)",\n' +
    '        "url": "https://youtube.com/watch?v=iJjSjmZnNlI",\n' +
    '        "view_count": 132304\n' +
    '      },\n' +
    '      {\n' +
    '        "title": "LangChain - Conversations with Memory (explanation & code walkthrough)",\n' +
    '        "url": "https://youtube.com/watch?v=X550Zbz_ROE",\n' +
    '        "view_count": 67183\n' +
    '      },\n' +
    '      {\n' +
    '        "title": "Chatbot Answering from Your Own Knowledge Base: Langchain, ChatGPT, Pinecone, and Streamlit: | Code",\n' +
    '        "url": "https://youtube.com/watch?v=nAKhxQ3hcMA",\n' +
    '        "view_count": 85334\n' +
    '      },\n' +
    '      {\n' +
    '        "title": "How to Build an AI Document Chatbot in 10 Minutes",\n' +
    '        "url": "https://youtube.com/watch?v=riXpu1tHzl0",\n' +
    '        "view_count": 359860\n' +
    '      },\n' +
    '      {\n' +
    '        "title": "Create Your Own AI Person (For Free)",\n' +
    '        "url": "https://youtube.com/watch?v=cutA4MKm9uY",\n' +
    '        "view_count": 366526\n' +
    '      }\n' +
    '    ]\n' +
    '  },\n' +
    '  {\n' +
    '    "score": 4,\n' +
    '    "video_title": "Establishing a Fixed Chapter List for Your Book in CrewAI",\n' +
    '    "description": "In this video, we will explain how to create a fixed structure for your book chapters in CrewAI. This will guide you on setting predefined chapter names and their order.",\n' +
    '    "video_id": "5cc8c8a8-544b-44ce-b08f-ef90551ebc2a",\n' +
    '    "comment_id": "e9d60d40-d09d-4342-b7b4-f71659b4af42",\n' +
    '    "research": [\n' +
    '      {\n' +
    `        "title": "ChatGPT for Children's Books: Faster, Better, More Consistent!",\n` +
    '        "url": "https://youtube.com/watch?v=Md33aa1TTyc",\n' +
    '        "view_count": 27205\n' +
    '      },\n' +
    '      {\n' +
    '        "title": "How We Made That App Episode 7: Revolutionizing Language Models and Data Processing with LlamaIndex",\n' +
    '        "url": "https://youtube.com/watch?v=snpZI8LsESA",\n' +
    '        "view_count": 4183\n' +
    '      },\n' +
    '      {\n' +
    '        "title": "How to Really Use Anthropic Claude 3.5 Sonnet Pro - Working with Text, Documents, and Artifacts",\n' +
    '        "url": "https://youtube.com/watch?v=1UYiYbdNVP0",\n' +
    '        "view_count": 765\n' +
    '      },\n' +
    '      {\n' +
    '        "title": "Technical E-book Creation with LLMs and Agentic Frameworks",\n' +
    '        "url": "https://youtube.com/watch?v=HllsvzY-ZLQ",\n' +
    '        "view_count": 72\n' +
    '      },\n' +
    '      {\n' +
    '        "title": "8+ Agents work together to author a book + audiobook + book webpage",\n' +
    '        "url": "https://youtube.com/watch?v=x6iHpNCkZKU",\n' +
    '        "view_count": 1190\n' +
    '      }\n' +
    '    ]\n' +
    '  },\n' +
    '  {\n' +
    '    "score": 7,\n' +
    '    "video_title": "Using Vector Stores as a Book Repository in CrewAI",\n' +
    '    "description": "Find out how to utilize a vector store as the repository for your book within CrewAI. We will explore how to switch the researcher settings to pull data from a vector store instead of the internet.",\n' +
    '    "video_id": "5cc8c8a8-544b-44ce-b08f-ef90551ebc2a",\n' +
    '    "comment_id": "4fb8268e-9e3f-48f5-9fcf-4c69e54623f4",\n' +
    '    "research": [\n' +
    '      {\n' +
    '        "title": "LangChain Retrieval QA Over Multiple Files with ChromaDB",\n' +
    '        "url": "https://youtube.com/watch?v=3yPBVii7Ct0",\n' +
    '        "view_count": 110085\n' +
    '      },\n' +
    '      {\n' +
    '        "title": "How to Build an AI Document Chatbot in 10 Minutes",\n' +
    '        "url": "https://youtube.com/watch?v=riXpu1tHzl0",\n' +
    '        "view_count": 359860\n' +
    '      },\n' +
    '      {\n' +
    '        "title": "Learn How To Query Pdf using Langchain Open AI in 5 min",\n' +
    '        "url": "https://youtube.com/watch?v=5Ghv-F1wF_0",\n' +
    '        "view_count": 105268\n' +
    '      },\n' +
    '      {\n' +
    '        "title": "Build Anything with Llama 3 Agents, Here’s How",\n' +
    '        "url": "https://youtube.com/watch?v=i-txsBoTJtI",\n' +
    '        "view_count": 154180\n' +
    '      },\n' +
    '      {\n' +
    '        "title": "PrivateGPT 2.0 - FULLY LOCAL Chat With Docs (PDF, TXT, HTML, PPTX, DOCX, and more)",\n' +
    '        "url": "https://youtube.com/watch?v=XFiof0V3nhA",\n' +
    '        "view_count": 388386\n' +
    '      }\n' +
    '    ]\n' +
    '  },\n' +
    '  {\n' +
    '    "score": 3,\n' +
    '    "video_title": "Troubleshooting Exceptions in CrewAI: Tips and Tricks",\n' +
    `    "description": "This video provides guidance on managing and troubleshooting exceptions that can disrupt your CrewAI experience. We'll share practical tips to prevent and resolve common issues.",\n` +
    '    "video_id": "5cc8c8a8-544b-44ce-b08f-ef90551ebc2a",\n' +
    '    "comment_id": "91aa50fe-4f37-4126-81c9-625284a57f39",\n' +
    '    "research": [\n' +
    '      {\n' +
    '        "title": "CrewAI RAG Deep Dive [Basic & Advanced Examples]",\n' +
    '        "url": "https://youtube.com/watch?v=7GhWXODugWM",\n' +
    '        "view_count": 23421\n' +
    '      },\n' +
    '      {\n' +
    '        "title": "How I Made AI Assistants Do My Work For Me: CrewAI",\n' +
    '        "url": "https://youtube.com/watch?v=kJvXT25LkwA",\n' +
    '        "view_count": 872460\n' +
    '      },\n' +
    '      {\n' +
    '        "title": "Forget CrewAI & AutoGen, Build CUSTOM AI Agents!",\n' +
    '        "url": "https://youtube.com/watch?v=CV1YgIWepoI",\n' +
    '        "view_count": 25738\n' +
    '      },\n' +
    '      {\n' +
    '        "title": "The Fundamentals of CrewAI and AgentOps",\n' +
    '        "url": "https://youtube.com/watch?v=X1tH1LKs9M0",\n' +
    '        "view_count": 753\n' +
    '      },\n' +
    '      {\n' +
    '        "title": "CrewAI and AgentOps for beginners",\n' +
    '        "url": "https://youtube.com/watch?v=lfUDYoYMhmY",\n' +
    '        "view_count": 848\n' +
    '      }\n' +
    '    ]\n' +
    '  }\n' +
    ']',
  last_step: {
    prompt: 'Action: Search and Get YouTube Video Details  \n' +
      'Action Input: {"keyword": "Troubleshooting Exceptions in CrewAI: Tips and Tricks", "max_results": 5}  \n' +
      '\n' +
      "Observation: [{'title': 'CrewAI RAG Deep Dive [Basic & Advanced Examples]', 'view_count': 23421, 'url': 'https://youtube.com/watch?v=7GhWXODugWM'}, {'title': 'How I Made AI Assistants Do My Work For Me: CrewAI', 'view_count': 872460, 'url': 'https://youtube.com/watch?v=kJvXT25LkwA'}, {'title': 'Forget CrewAI & AutoGen, Build CUSTOM AI Agents!', 'view_count': 25738, 'url': 'https://youtube.com/watch?v=CV1YgIWepoI'}, {'title': 'The Fundamentals of CrewAI and AgentOps', 'view_count': 753, 'url': 'https://youtube.com/watch?v=X1tH1LKs9M0'}, {'title': 'CrewAI and AgentOps for beginners', 'view_count': 848, 'url': 'https://youtube.com/watch?v=lfUDYoYMhmY'}]\n" +
      '\n' +
      '\n' +
      'You ONLY have access to the following tools, and should NEVER make up tools that are not listed here:\n' +
      '\n' +
      'Tool Name: Search and Get YouTube Video Details\n' +
      "Tool Description: Search and Get YouTube Video Details(keyword: 'string', max_results: 'integer') - Searches YouTube videos based on a keyword and retrieves details for each video. keyword: 'The search keyword.', max_results: 'The maximum number of results to return.'\n" +
      "Tool Arguments: {'keyword': {'description': 'The search keyword.', 'type': 'str'}, 'max_results': {'description': 'The maximum number of results to return.', 'type': 'int'}}\n" +
      '\n' +
      'Use the following format:\n' +
      '\n' +
      'Thought: you should always think about what to do\n' +
      "Action: the action to take, only one name of [Search and Get YouTube Video Details], just the name, exactly as it's written.\n" +
      'Action Input: the input to the action, just a simple python dictionary, enclosed in curly braces, using " to wrap keys and values.\n' +
      'Observation: the result of the action\n' +
      '\n' +
      'Once all necessary information is gathered:\n' +
      '\n' +
      'Thought: I now know the final answer\n' +
      'Final Answer: the final answer to the original input question\n',
    thought: '',
    tool: 'Search and Get YouTube Video Details',
    tool_input: '{"keyword": "Troubleshooting Exceptions in CrewAI: Tips and Tricks", "max_results": 5}',
    result: "[{'title': 'CrewAI RAG Deep Dive [Basic & Advanced Examples]', 'view_count': 23421, 'url': 'https://youtube.com/watch?v=7GhWXODugWM'}, {'title': 'How I Made AI Assistants Do My Work For Me: CrewAI', 'view_count': 872460, 'url': 'https://youtube.com/watch?v=kJvXT25LkwA'}, {'title': 'Forget CrewAI & AutoGen, Build CUSTOM AI Agents!', 'view_count': 25738, 'url': 'https://youtube.com/watch?v=CV1YgIWepoI'}, {'title': 'The Fundamentals of CrewAI and AgentOps', 'view_count': 753, 'url': 'https://youtube.com/watch?v=X1tH1LKs9M0'}, {'title': 'CrewAI and AgentOps for beginners', 'view_count': 848, 'url': 'https://youtube.com/watch?v=lfUDYoYMhmY'}]\n" +
      '\n' +
      '\n' +
      'You ONLY have access to the following tools, and should NEVER make up tools that are not listed here:\n' +
      '\n' +
      'Tool Name: Search and Get YouTube Video Details\n' +
      "Tool Description: Search and Get YouTube Video Details(keyword: 'string', max_results: 'integer') - Searches YouTube videos based on a keyword and retrieves details for each video. keyword: 'The search keyword.', max_results: 'The maximum number of results to return.'\n" +
      "Tool Arguments: {'keyword': {'description': 'The search keyword.', 'type': 'str'}, 'max_results': {'description': 'The maximum number of results to return.', 'type': 'int'}}\n" +
      '\n' +
      'Use the following format:\n' +
      '\n' +
      'Thought: you should always think about what to do\n' +
      "Action: the action to take, only one name of [Search and Get YouTube Video Details], just the name, exactly as it's written.\n" +
      'Action Input: the input to the action, just a simple python dictionary, enclosed in curly braces, using " to wrap keys and values.\n' +
      'Observation: the result of the action\n' +
      '\n' +
      'Once all necessary information is gathered:\n' +
      '\n' +
      'Thought: I now know the final answer\n' +
      'Final Answer: the final answer to the original input question\n',
    kickoff_id: 'df23d8c2-3c2b-4c98-b225-d9efc621b224',
    meta: {}
  },
  last_executed_task: {
    description: 'Assign a score between 1 and 10 to each video idea based on the existing research data. Videos with high view counts in the research data should receive a higher score, indicating a strong market interest, while ideas with low view counts should score lower.\n' +
      'Input Example: [\n' +
      '  [\n' +
      '    "video_title": "CrewAI Flows RAG Crash Course",\n' +
      '    "description": "In this tutorial, talk about how you can use RAG inside of your flows.",\n' +
      '    "video_id": "123",\n' +
      '    "comment_id": "abc",\n' +
      '    "research": [\n' +
      '      [\n' +
      '        "title": "How to use RAG tools in CrewAI",\n' +
      '        "url": "https://youtube.com/123",\n' +
      '        "view_count": 23456\n' +
      '      ]\n' +
      '    ]\n' +
      '  ]\n' +
      ']\n' +
      'Calculate a score based on view count metrics and add it to each video idea.\n',
    name: 'score_video_ideas_task',
    expected_output: 'Each video idea should now include: - score: A value between 1 and 10 representing the potential popularity of the idea.\n' +
      'Example Output: [\n' +
      '  [\n' +
      '    "score": 7,\n' +
      '    "video_title": "CrewAI Flows RAG Crash Course",\n' +
      '    "description": "In this tutorial, talk about how you can use RAG inside of your flows.",\n' +
      '    "video_id": "123",\n' +
      '    "comment_id": "abc",\n' +
      '    "research": [\n' +
      '      [\n' +
      '        "title": "How to use RAG tools in CrewAI",\n' +
      '        "url": "https://youtube.com/123",\n' +
      '        "view_count": 23456\n' +
      '      ]\n' +
      '    ]\n' +
      '  ]\n' +
      ']\n',
    summary: 'Assign a score between 1 and 10 to each video...',
    agent: 'Scoring Analyst',
    output: '[\n' +
      '  {\n' +
      '    "score": 5,\n' +
      '    "video_title": "CrewAI Flows Crash Course: Do You Need to Subscribe for Codes?",\n' +
      '    "description": "In this video, we will address whether a subscription is necessary for accessing code snippets and features when using CrewAI. We will explore the different options available for users.",\n' +
      '    "video_id": "5cc8c8a8-544b-44ce-b08f-ef90551ebc2a",\n' +
      '    "comment_id": "9853d4e8-d21b-45c7-a6d6-1927f01aadad",\n' +
      '    "research": [\n' +
      '      {\n' +
      '        "title": "CrewAI Flows Crash Course",\n' +
      '        "url": "https://youtube.com/watch?v=8PtGcNE01yo",\n' +
      '        "view_count": 6534\n' +
      '      },\n' +
      '      {\n' +
      '        "title": "CrewAI Tutorial: Complete Crash Course for Beginners",\n' +
      '        "url": "https://youtube.com/watch?v=sPzc6hMg7So",\n' +
      '        "view_count": 195284\n' +
      '      },\n' +
      '      {\n' +
      '        "title": "LangGraph + CrewAI: Crash Course for Beginners [Source Code Included]",\n' +
      '        "url": "https://youtube.com/watch?v=5eYg1OcHm5k",\n' +
      '        "view_count": 31119\n' +
      '      },\n' +
      '      {\n' +
      '        "title": "CrewAI Tutorial for Beginners: Learn How To Use Latest CrewAI Features",\n' +
      '        "url": "https://youtube.com/watch?v=Jl6BuoXcZPE",\n' +
      '        "view_count": 78853\n' +
      '      },\n' +
      '      {\n' +
      '        "title": "crewAI Crash Course For Beginners-How To Create Multi AI Agent For Complex Usecases",\n' +
      '        "url": "https://youtube.com/watch?v=UV81LAb3x2g",\n' +
      '        "view_count": 42009\n' +
      '      }\n' +
      '    ]\n' +
      '  },\n' +
      '  {\n' +
      '    "score": 6,\n' +
      '    "video_title": "Improving UX for Plotting Multiple Chapters in CrewAI",\n' +
      '    "description": "This video discusses user experience improvements in CrewAI, particularly focusing on how to enhance the plotting of multiple chapters within a book. We will walk through some practical solutions.",\n' +
      '    "video_id": "5cc8c8a8-544b-44ce-b08f-ef90551ebc2a",\n' +
      '    "comment_id": "d492d1fc-14f2-4f51-bccb-b1963e908ec4",\n' +
      '    "research": [\n' +
      '      {\n' +
      '        "title": "How much does a SOFTWARE ENGINEER make?",\n' +
      '        "url": "https://youtube.com/watch?v=XkzPmtzdIEY",\n' +
      '        "view_count": 7062526\n' +
      '      },\n' +
      '      {\n' +
      '        "title": "7 Prompt Chains for Decision Making, Self Correcting, Reliable AI Agents",\n' +
      '        "url": "https://youtube.com/watch?v=QV6kaNFyoyQ",\n' +
      '        "view_count": 30288\n' +
      '      },\n' +
      '      {\n' +
      '        "title": "Build Anything with Perplexity, Here’s How",\n' +
      '        "url": "https://youtube.com/watch?v=w_YRnA8RdnU",\n' +
      '        "view_count": 220935\n' +
      '      },\n' +
      '      {\n' +
      '        "title": "15 INSANE Use Cases for NEW Claude Sonnet 3.5! (Outperforms GPT-4o)",\n' +
      '        "url": "https://youtube.com/watch?v=wBJZQt23J7M",\n' +
      '        "view_count": 226689\n' +
      '      },\n' +
      '      {\n' +
      '        "title": "How We Made That App Episode 7: Revolutionizing Language Models and Data Processing with LlamaIndex",\n' +
      '        "url": "https://youtube.com/watch?v=snpZI8LsESA",\n' +
      '        "view_count": 4183\n' +
      '      }\n' +
      '    ]\n' +
      '  },\n' +
      '  {\n' +
      '    "score": 8,\n' +
      '    "video_title": "Creating an Interactive Chatbot with Memory Using CrewAI",\n' +
      '    "description": "Join us as we develop an interactive chatbot using CrewAI. This video will cover how to implement memory features and maintain an engaging conversation flow throughout user interactions.",\n' +
      '    "video_id": "5cc8c8a8-544b-44ce-b08f-ef90551ebc2a",\n' +
      '    "comment_id": "2289d021-aebf-4c5a-900b-d40bf10e8642",\n' +
      '    "research": [\n' +
      '      {\n' +
      '        "title": "The RIGHT WAY To Build AI Agents with CrewAI (BONUS: 100% Local)",\n' +
      '        "url": "https://youtube.com/watch?v=iJjSjmZnNlI",\n' +
      '        "view_count": 132304\n' +
      '      },\n' +
      '      {\n' +
      '        "title": "LangChain - Conversations with Memory (explanation & code walkthrough)",\n' +
      '        "url": "https://youtube.com/watch?v=X550Zbz_ROE",\n' +
      '        "view_count": 67183\n' +
      '      },\n' +
      '      {\n' +
      '        "title": "Chatbot Answering from Your Own Knowledge Base: Langchain, ChatGPT, Pinecone, and Streamlit: | Code",\n' +
      '        "url": "https://youtube.com/watch?v=nAKhxQ3hcMA",\n' +
      '        "view_count": 85334\n' +
      '      },\n' +
      '      {\n' +
      '        "title": "How to Build an AI Document Chatbot in 10 Minutes",\n' +
      '        "url": "https://youtube.com/watch?v=riXpu1tHzl0",\n' +
      '        "view_count": 359860\n' +
      '      },\n' +
      '      {\n' +
      '        "title": "Create Your Own AI Person (For Free)",\n' +
      '        "url": "https://youtube.com/watch?v=cutA4MKm9uY",\n' +
      '        "view_count": 366526\n' +
      '      }\n' +
      '    ]\n' +
      '  },\n' +
      '  {\n' +
      '    "score": 4,\n' +
      '    "video_title": "Establishing a Fixed Chapter List for Your Book in CrewAI",\n' +
      '    "description": "In this video, we will explain how to create a fixed structure for your book chapters in CrewAI. This will guide you on setting predefined chapter names and their order.",\n' +
      '    "video_id": "5cc8c8a8-544b-44ce-b08f-ef90551ebc2a",\n' +
      '    "comment_id": "e9d60d40-d09d-4342-b7b4-f71659b4af42",\n' +
      '    "research": [\n' +
      '      {\n' +
      `        "title": "ChatGPT for Children's Books: Faster, Better, More Consistent!",\n` +
      '        "url": "https://youtube.com/watch?v=Md33aa1TTyc",\n' +
      '        "view_count": 27205\n' +
      '      },\n' +
      '      {\n' +
      '        "title": "How We Made That App Episode 7: Revolutionizing Language Models and Data Processing with LlamaIndex",\n' +
      '        "url": "https://youtube.com/watch?v=snpZI8LsESA",\n' +
      '        "view_count": 4183\n' +
      '      },\n' +
      '      {\n' +
      '        "title": "How to Really Use Anthropic Claude 3.5 Sonnet Pro - Working with Text, Documents, and Artifacts",\n' +
      '        "url": "https://youtube.com/watch?v=1UYiYbdNVP0",\n' +
      '        "view_count": 765\n' +
      '      },\n' +
      '      {\n' +
      '        "title": "Technical E-book Creation with LLMs and Agentic Frameworks",\n' +
      '        "url": "https://youtube.com/watch?v=HllsvzY-ZLQ",\n' +
      '        "view_count": 72\n' +
      '      },\n' +
      '      {\n' +
      '        "title": "8+ Agents work together to author a book + audiobook + book webpage",\n' +
      '        "url": "https://youtube.com/watch?v=x6iHpNCkZKU",\n' +
      '        "view_count": 1190\n' +
      '      }\n' +
      '    ]\n' +
      '  },\n' +
      '  {\n' +
      '    "score": 7,\n' +
      '    "video_title": "Using Vector Stores as a Book Repository in CrewAI",\n' +
      '    "description": "Find out how to utilize a vector store as the repository for your book within CrewAI. We will explore how to switch the researcher settings to pull data from a vector store instead of the internet.",\n' +
      '    "video_id": "5cc8c8a8-544b-44ce-b08f-ef90551ebc2a",\n' +
      '    "comment_id": "4fb8268e-9e3f-48f5-9fcf-4c69e54623f4",\n' +
      '    "research": [\n' +
      '      {\n' +
      '        "title": "LangChain Retrieval QA Over Multiple Files with ChromaDB",\n' +
      '        "url": "https://youtube.com/watch?v=3yPBVii7Ct0",\n' +
      '        "view_count": 110085\n' +
      '      },\n' +
      '      {\n' +
      '        "title": "How to Build an AI Document Chatbot in 10 Minutes",\n' +
      '        "url": "https://youtube.com/watch?v=riXpu1tHzl0",\n' +
      '        "view_count": 359860\n' +
      '      },\n' +
      '      {\n' +
      '        "title": "Learn How To Query Pdf using Langchain Open AI in 5 min",\n' +
      '        "url": "https://youtube.com/watch?v=5Ghv-F1wF_0",\n' +
      '        "view_count": 105268\n' +
      '      },\n' +
      '      {\n' +
      '        "title": "Build Anything with Llama 3 Agents, Here’s How",\n' +
      '        "url": "https://youtube.com/watch?v=i-txsBoTJtI",\n' +
      '        "view_count": 154180\n' +
      '      },\n' +
      '      {\n' +
      '        "title": "PrivateGPT 2.0 - FULLY LOCAL Chat With Docs (PDF, TXT, HTML, PPTX, DOCX, and more)",\n' +
      '        "url": "https://youtube.com/watch?v=XFiof0V3nhA",\n' +
      '        "view_count": 388386\n' +
      '      }\n' +
      '    ]\n' +
      '  },\n' +
      '  {\n' +
      '    "score": 3,\n' +
      '    "video_title": "Troubleshooting Exceptions in CrewAI: Tips and Tricks",\n' +
      `    "description": "This video provides guidance on managing and troubleshooting exceptions that can disrupt your CrewAI experience. We'll share practical tips to prevent and resolve common issues.",\n` +
      '    "video_id": "5cc8c8a8-544b-44ce-b08f-ef90551ebc2a",\n' +
      '    "comment_id": "91aa50fe-4f37-4126-81c9-625284a57f39",\n' +
      '    "research": [\n' +
      '      {\n' +
      '        "title": "CrewAI RAG Deep Dive [Basic & Advanced Examples]",\n' +
      '        "url": "https://youtube.com/watch?v=7GhWXODugWM",\n' +
      '        "view_count": 23421\n' +
      '      },\n' +
      '      {\n' +
      '        "title": "How I Made AI Assistants Do My Work For Me: CrewAI",\n' +
      '        "url": "https://youtube.com/watch?v=kJvXT25LkwA",\n' +
      '        "view_count": 872460\n' +
      '      },\n' +
      '      {\n' +
      '        "title": "Forget CrewAI & AutoGen, Build CUSTOM AI Agents!",\n' +
      '        "url": "https://youtube.com/watch?v=CV1YgIWepoI",\n' +
      '        "view_count": 25738\n' +
      '      },\n' +
      '      {\n' +
      '        "title": "The Fundamentals of CrewAI and AgentOps",\n' +
      '        "url": "https://youtube.com/watch?v=X1tH1LKs9M0",\n' +
      '        "view_count": 753\n' +
      '      },\n' +
      '      {\n' +
      '        "title": "CrewAI and AgentOps for beginners",\n' +
      '        "url": "https://youtube.com/watch?v=lfUDYoYMhmY",\n' +
      '        "view_count": 848\n' +
      '      }\n' +
      '    ]\n' +
      '  }\n' +
      ']',
    output_json: null,
    kickoff_id: 'df23d8c2-3c2b-4c98-b225-d9efc621b224',
    meta: {}
  }
}

*/