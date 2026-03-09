import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const response = await controlPlaneFetch("/ec2/trigger", { method: "POST" });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to trigger EC2 image build:", error);
    return NextResponse.json({ error: "Failed to trigger EC2 image build" }, { status: 500 });
  }
}
