"use client";

import Image from "next/image";
import Link from "next/link";
import { useState, useEffect } from "react";
import { formatDistanceToNow } from "date-fns";
import { Video } from "@/server/db/schema";
import { Button } from "@/components/ui/button";
import { scrapeVideos } from "@/server/youtube-actions";
import { useToast } from "@/hooks/use-toast";
import { formatCount } from "@/lib/utils";
import { Loader2, TvMinimal } from "lucide-react";

export default function VideoList({
  initialVideos,
}: {
  initialVideos: Video[];
}) {
  const [isScraping, setIsScraping] = useState(false);
  const [videos, setVideos] = useState(initialVideos);
  const { toast } = useToast();

  const handleScrape = async () => {
    setIsScraping(true);
    try {
      const newVideos = await scrapeVideos();
      setVideos((prevVideos) => [...newVideos, ...prevVideos]);
      toast({
        title: "Scrape Successful",
        description: `Scraped ${newVideos.length} new videos`,
      });
    } catch (error) {
      console.error("Error scraping videos:", error);
      let errorMessage = "An unknown error occurred";

      if (error instanceof Error) {
        if (error.message.includes("No channels found for the user")) {
          errorMessage =
            "Please add YouTube channels first by clicking settings in the top right.";
        } else {
          errorMessage = error.message;
        }
      }

      console.log("errorMessage", errorMessage);
      toast({
        title: "Scrape Failed",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setIsScraping(false);
    }
  };

  useEffect(() => {
    setVideos(initialVideos);
  }, [initialVideos]);

  if (videos.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-4 space-y-5">
        <div className="bg-red-50 rounded-xl p-3">
          <TvMinimal className="h-11 w-11 text-red-500" strokeWidth={1.5} />
        </div>
        <h3 className="text-2xl font-semibold text-gray-900">No videos yet</h3>
        <p className="text-gray-500 text-center max-w-md">
          Please add YouTube channels and then scrape for videos. Video comments
          will be analyzed for content ideas.
        </p>
        <Button
          onClick={handleScrape}
          disabled={isScraping}
          className="bg-red-500 hover:bg-red-600 transition-all rounded-lg text-md font-semibold px-6 py-5"
        >
          {isScraping ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Scraping...
            </>
          ) : (
            <>Scrape Videos</>
          )}
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold">Videos</h1>
        <Button
          onClick={handleScrape}
          disabled={isScraping}
          className="bg-red-500 hover:bg-red-600 transition-all rounded-lg text-md font-semibold px-6 py-3"
        >
          {isScraping ? "Scraping..." : "Scrape"}
        </Button>
      </div>
      <div className="grid grid-cols-3 gap-6">
        {videos.map((video) => (
          <Link
            key={video.id}
            href={`/video/${video.id}`}
            className="group block"
          >
            <div className="rounded-2xl overflow-hidden border bg-white shadow-sm p-4 space-y-3 hover:scale-[1.05] transition-all duration-300">
              <div className="aspect-video relative">
                {video.thumbnailUrl ? (
                  <Image
                    src={video.thumbnailUrl}
                    alt={video.title}
                    fill
                    className="object-cover rounded-lg"
                  />
                ) : (
                  <div className="w-full h-full bg-gray-200 flex items-center justify-center">
                    <span className="text-gray-400">No thumbnail</span>
                  </div>
                )}
              </div>
              <div className="space-y-1.5">
                <h2 className="font-semibold line-clamp-2 group-hover:text-primary">
                  {video.title}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {video.channelTitle}
                </p>
                <div className="flex items-center text-xs text-muted-foreground">
                  <span>
                    {video.viewCount ? formatCount(video.viewCount) : "0"} views
                  </span>
                  <span className="mx-1">•</span>
                  <span>
                    {formatDistanceToNow(new Date(video.publishedAt))} ago
                  </span>
                </div>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}