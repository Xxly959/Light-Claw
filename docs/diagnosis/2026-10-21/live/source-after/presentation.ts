import type { AssistantMessage } from "@mariozechner/pi-ai";

export interface AssistantPresentation {
	text: string;
	thinking: string[];
}

export interface ErrorPresentation {
	message: string;
	detail?: string;
}

/** 将模型内容拆成用户回答和仅供本地日志记录的推理内容。 */
export function splitAssistantContent(content: AssistantMessage["content"]): AssistantPresentation {
	const text: string[] = [];
	const thinking: string[] = [];
	for (const part of content) {
		if (part.type === "text") text.push(part.text);
		else if (part.type === "thinking") thinking.push(part.thinking);
	}
	return { text: text.join("\n"), thinking };
}

/** 目标已落盘完成时，后续网关错误不能覆盖成功结果。 */
export function formatRunError(errorMessage: string, goalCompleted: boolean): ErrorPresentation {
	if (goalCompleted) {
		return { message: "目标已完成并保存证据。模型网关在生成收尾回复时暂时不可用，可稍后继续对话。" };
	}
	return { message: "执行失败，请查看话题中的错误详情。", detail: errorMessage };
}
