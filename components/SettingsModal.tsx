"use client";

import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, X } from "lucide-react";

import { YouTubeChannelType } from "@/server/db/schema";

import { ScrollArea } from "@/components/ui/scroll-area";
import { getChannelsForUser } from "@/server/queries";
import { addChannelForUser, removeChannelForUser } from "@/server/mutations";


export function SettingsModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [channels, setChannels] = useState<YouTubeChannelType[]>([]);
  const [newChannel, setNewChannel] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      fetchChannels();
    }
  }, [isOpen]);

  const fetchChannels = async () => {
    setIsLoading(true);
    try {
      const fetchedChannels = await getChannelsForUser();
      setChannels(fetchedChannels);
    } catch (error) {
      console.error("Failed to fetch channels:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const addChannel = async () => {
    if (newChannel) {
      setIsLoading(true);
      try {
        const addedChannel = await addChannelForUser(newChannel);
        setChannels([...channels, addedChannel]);
        setNewChannel("");
      } catch (error) {
        console.error("Failed to add channel:", error);
      } finally {
        setIsLoading(false);
      }
    }
  };

  const removeChannel = async (id: string) => {
    setIsLoading(true);
    try {
      await removeChannelForUser(id);
      setChannels(channels.filter((c) => c.id !== id));
    } catch (error) {
      console.error("Failed to remove channel:", error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <p className="cursor-pointer text-primary hover:text-red-500 transition-all">
          Settings
        </p>
      </DialogTrigger>
      <DialogContent className="max-w-[425px] rounded-2xl p-6 space-y-2">
        <div className="py-4 space-y-6">
          <div className="space-y-2">
            <h3 className="font-semibold text-red-500 text-lg">
              Add New Channel
            </h3>
            <div className="flex space-x-2">
              <Input
                placeholder="Channel name"
                value={newChannel}
                onChange={(e) => setNewChannel(e.target.value)}
                className="focus-visible:ring-0 text-md px-4 py-2 h-10"
              />
              <Button
                onClick={addChannel}
                disabled={isLoading}
                className="bg-red-500 hover:bg-red-600 transition-all h-10 rounded-lg font-semibold"
              >
                <Plus className="h-4 w-4" strokeWidth={3} />
                <p>Add</p>
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <h3 className="font-semibold text-red-500 text-lg">
              Saved Channels
            </h3>
            {isLoading ? (
              <p className="h-[150px] flex items-center justify-center">
                Loading...
              </p>
            ) : (
              <ScrollArea className="h-[150px]">
                {channels.map((channel) => (
                  <div
                    key={channel.id}
                    className="flex items-center justify-between border rounded-lg shadow-sm px-4 py-2 bg-gray-50 mb-2"
                  >
                    <span>{channel.name}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeChannel(channel.id)}
                      disabled={isLoading}
                    >
                      <X className="h-4 w-4 text-red-500 hover:bg-red-50 rounded-md" />
                    </Button>
                  </div>
                ))}
              </ScrollArea>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}