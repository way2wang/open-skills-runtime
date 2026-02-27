import { skillManager } from './skill_manager';
import OpenAI from 'openai';
import { EventEmitter } from 'node:events';
import { Engine, Execution } from 'bpmn-engine'
import { env } from 'node:process';
// import camundaModdle from 'camunda-bpmn-moddle/resources/camunda.json';
// import { ipcMain } from 'electron';

// 初始化 OpenAI 客户端
const openai = new OpenAI({
  baseURL: "", // 指向你的 OpenAI 兼容服务
  apiKey: "", // 使用配置中的 API 密钥
});
const model = "";
const eventEmitter = new EventEmitter();
/**
 * 调用大模型API获取反馈，skill执行进程调用此接口
 * @param args 消息内容数组
 * @param options 可选的配置选项
 * @returns 大模型的回复内容
 */
async function chatLLM(args: OpenAI.ChatCompletionCreateParams): Promise<string> {
  try {

    // 调用大模型API
    const chatResp = await openai.chat.completions.create(args);

    const choice = chatResp.choices[0];
    const response = choice.message.content?.trim() || '';
    
    return response.replace(/<think>[\s\S]*?<\/think>/, '').trim();;
  } catch (error) {
    throw error;
  }
}
  
/**
 * 技能运行时类
 */
class SkillRuntime {
  private openai: OpenAI;
  private model: string = '';
  private eventEmitter: EventEmitter;
  private waitingTasks: Array<any>=[]

  constructor() {
    // 初始化 OpenAI 客户端
    this.openai = new OpenAI({
      baseURL: "", // 指向你的 OpenAI 兼容服务
      apiKey: "", // 使用配置中的 API 密钥
    });
    this.model = "";
    this.eventEmitter = eventEmitter

    this.eventEmitter.on('skill:user-task-feedback', (_: any, id: any, text: any) => {
      let elementApi = this.waitingTasks.find(task => task.id == id)
      elementApi.environment.output[elementApi.environment.variables[elementApi.id].output.name] = text
      elementApi.signal();
      const index = this.waitingTasks.indexOf(elementApi)
      this.waitingTasks.splice(index, 1)
    })
  }

  /**
   * 匹配用户任务到相关技能（使用LLM判断）
   * @param userInput 用户输入
   * @returns 匹配到的技能名称列表
   */
  async matchSkills(userInput: string): Promise<string[]> {
    try {
      // 获取所有可用技能
      const skills = await skillManager.listSkills();
      console.log("Available skills:", skills);
      
      if (skills.length === 0) {
        console.log('没有可用技能');
        return [];
      }

      // 构建提示词
      let prompt = `用户输入: ${userInput}\n\n`;
      prompt += `可用技能列表:\n\n`;
      
      skills.forEach((skill, index) => {
        prompt += `## 技能${index + 1}\n`;
        prompt += `- **名称**: ${skill.name}\n`;
        prompt += `- **描述**: ${skill.description}\n\n`;
      });
      
      prompt += `\n请判断是否需要使用技能，如果需要，请明确指出使用哪个技能。`;
      prompt += `\n请严格按照以下格式输出，不要添加其他内容：`;
      prompt += `\n如果使用技能，输出格式为：使用技能: 技能名称`;
      prompt += `\n如果不需要使用技能，输出格式为：不使用技能`;
      
      // 调用大模型API
      const chatResp = await this.openai.chat.completions.create({
        messages: [
          {
            role: "system",
            content: "你是一个专业的技能匹配助手，负责根据用户输入判断是否需要使用技能以及使用哪个技能。请严格按照指定格式输出结果。"
          },
          {
            role: "user",
            content: prompt
          }
        ],
        model: this.model,
        temperature: 0.1
      });

      const choice = chatResp.choices[0];
      const response = choice.message.content?.trim() || '';
      
      console.log(`模型输出: ${response}`);

      // 解析模型输出
      if (response.includes("不使用技能")) {
        return [];
      } else if (response.includes("使用技能:")) {
        const skillName = response.split("使用技能:")[1].trim();
        return [skillName];
      } else {
        // 如果输出格式不正确，尝试从技能名称中匹配
        const matchedSkills: string[] = [];
        // const lowerResponse = response.toLowerCase();
        
        // for (const skill of skills) {
        //   if (lowerResponse.includes(skill.name.toLowerCase())) {
        //     matchedSkills.push(skill.name);
        //   }
        // }
        
        return matchedSkills;
      }
    } catch (error) {
      console.log('匹配技能时出错:', error);
      return [];
    }
  }

  /**
   * 调用大模型API将正文转换为BPMN格式并清理输出
   * @param skillContent 技能正文内容
   * @returns 清理后的BPMN格式内容
   */
  private async convertToBpmn(skillContent: string): Promise<string> {
    try {
      // 调用大模型API将正文转换为mermaid格式
      const chatResp = await this.openai.chat.completions.create({
        messages: [
          {
            role: "system",
            content: "你是精通BPMN 2.0标准的专业流程助手"
          },
          {
            role: "user",
            content: `${skillContent}\n\n请根据以上内容生成严格符合BPMN 2.0标准的可执行XML。
            要求：
              1.只能使用三种任务类型：UserTask、ServiceTask、ScriptTask，每个任务都必须按标准格式定义name和documentation
              2.需要用户参与的用UserTask
              3.需要调用MCP的用ServiceTask，并在<bpmn:serviceTask>同一行设置属性implementation="\${environment.services.mcpService}"
              4.需要使用LLM的用ServiceTask，并在<bpmn:serviceTask>同一行设置属性implementation="\${environment.services.llmService}"
              5.需要执行用户脚本的用ScriptTask
              6.documentation的内容严格按照以下JSON格式输出：
                {
                "hint": "给用户的提示",
                "prompt": "给模型的提示",
                "input": {"name":"需要读取哪个变量","type":"文本|数字|布尔|集合"},
                "output": {"name":"输出变量名称","type":"文本|数字|布尔|集合"}
                }
              7.不要添加其他内容`
          }
        ],
        model: this.model,
        temperature: 0.3
      });

      const choice = chatResp.choices[0];
      let response = choice.message.content?.trim() || '';
      
      console.log(`模型输出: ${response}`);
      
      // 清理输出内容，移除可能的思考过程
      response = response.replace(/<think>[\s\S]*?<\/think>/, '').trim();
      
      return response;
    } catch (error) {
      console.log('用大模型转换为BPMN流程时出错:', error);
      throw error;
    }
  }

  // 设置引擎监听器
  private async setupActivityListeners(listener:EventEmitter) {
    // 监听事件
    listener.on('activity.start', (elementApi, engineApi) => {
        if (elementApi.owner.behaviour.documentation && elementApi.owner.behaviour.documentation.length > 0) {
          const documentation = JSON.parse(elementApi.owner.behaviour.documentation[0].text);
          elementApi.environment.variables[elementApi.id] = documentation
        }
    })

    listener.on('wait', (elementApi) => {
      if (elementApi.type === 'bpmn:UserTask') {
        if (elementApi.environment.variables[elementApi.id] && elementApi.environment.variables[elementApi.id].hint) {
          let hint = elementApi.environment.variables[elementApi.id].hint
          const inputName = elementApi.environment.variables[elementApi.id].input.name
          let input = ''
          if (inputName && elementApi.environment.output[inputName]) {
            const value = elementApi.environment.output[inputName];
            if (typeof value === 'object' && value !== null) {
              input = JSON.stringify(value);
            } else {
              input = String(value);
            }
          }
          let outputType = elementApi.environment.variables[elementApi.id].output.type
          this.eventEmitter.emit('skill:user-task', elementApi.id, hint, input)

          this.waitingTasks.push(elementApi)
        }
      }
    });

    listener.on('activity.end', (elementApi) => {
      // console.log(`活动结束，ID: ${elementApi.id}, 名称: ${elementApi.name}\n${elementApi.type}`);
      if (elementApi.name) {
        this.eventEmitter.emit('skill-log', `活动结束: ${elementApi.name}`);
      }
    });
  }

  /**
   * 执行指定技能
   * @param skillName 技能名称
   * @param userInput 用户输入
   * @returns 执行结果
   */
  async executeSkill(skillName: string, userInput: string): Promise<Execution | null> {
    try {
      // 获取技能信息
      const skill = await skillManager.selectSkill(skillName);
      if (!skill) {
        console.error(`未找到技能: ${skillName}`);
        return null;
      }

      // 读取技能正文内容
      const skillContent = skillManager.readSkillContent(skill.path);
      if (!skillContent) {
        console.error(`无法读取技能内容: ${skillName}`);
        return null;
      }
      
      // 调用大模型API将正文转换为BPMN格式
      const bpmnXml = await this.convertToBpmn(skillContent);
      console.log("Raw BPMN Output:", bpmnXml);
      
      // 使用 bpmn-engine 执行 BPMN 流程
      let engine = new Engine({name: skill.name, source: bpmnXml});
      
      await this.setupActivityListeners(this.eventEmitter);

      engine.once('end', (execution) => {
        console.log("BPMN engine execution ended.");
        this.eventEmitter.emit('skill-log', '技能执行结束');
      });

      return engine.execute({
        listener: eventEmitter,
        variables: {
          skillContent: skillContent,
        },
        services: {
          llmService:this.llmService,
          mcpService:this.mcpService,
          scriptService: async (scope: any, callback: any) => {
            // 执行脚本逻辑
          },
        },
        extensions: {

        },
      }, 
      (err: Error, execution: any) => {
        if (err) {
          console.error('BPMN执行错误:', err);
          return;
        }
      });
      
    } catch (error) {
      console.error('执行技能时出错:', error);
      return null;
    }
  }

  async llmService(scope: any, callback: any) {
    // 调用大模型处理逻辑
    eventEmitter.emit('skill-log', `调用大模型处理任务: ${scope.content.name}`);
    // 调用LLM完成任务
    try {
      let messages: OpenAI.ChatCompletionMessageParam[] = []
      messages.push({
          role: "system",
          content: "你是一个专业的任务执行助手"
      });
      
      let outputType = '文本'
      let userPrompt = `技能内容：${scope.environment.variables.skillContent}\n`
      if (scope.environment.variables[scope.id] && scope.environment.output[scope.environment.variables[scope.id].input.name]) {
        userPrompt += `上下文信息：${JSON.stringify(scope.environment.output[scope.environment.variables[scope.id].input.name])}\n`
        outputType = scope.environment.variables[scope.id].output.type
      }
      userPrompt += `根据技能内容和上下文信息，${scope.environment.variables[scope.id].prompt}，结果类型为${outputType}；如果需要加载额外的资源，请给出资源路径。

请严格按照以下JSON格式输出：
{
"output": ,
"resourcePath": ""
}`;
      messages.push({
          role: "user",
          content: userPrompt
      });
      console.log("llmService chat prompt:", userPrompt);
      const chatResponse = await chatLLM({messages, stream:false, model:skillRuntime.model, temperature: 0.7});
      console.log("llmService chat Response:", chatResponse);
      
      let jsonResult: {
        output?: string;
        resourcePath?: string;
      } = {};
      try {
        // 尝试解析JSON，处理可能被```json和```包裹的情况
        let parsedResponse = chatResponse;
        if (parsedResponse.startsWith('```json') && parsedResponse.endsWith('```')) {
          // 移除```json和```包裹
          parsedResponse = parsedResponse.substring(7, parsedResponse.length - 3).trim();
        }
        // 尝试解析JSON
        jsonResult = JSON.parse(parsedResponse);
        // console.log("解析后的分析结果:", jsonResult);
      } catch (parseError) {
        // 如果解析失败，尝试从文本中提取信息
        console.log("JSON解析失败，尝试从文本中提取信息:", parseError);
        // 这里可以添加更复杂的文本解析逻辑
        jsonResult = {
          output: "",
          resourcePath: ""
        };
      }
      
      // 如果有资源路径，加载资源
      let resourceContent = "";
      if (jsonResult['resourcePath']) {
        // 这里应该实现资源加载逻辑，目前先简化处理
        console.log("需要加载资源:", jsonResult['resourcePath']);
      }
      
      const llmResult = jsonResult['output'] || '';
      // 将结果存入scope.environment.output
      scope.environment.output[scope.environment.variables[scope.id].output.name] = llmResult;
      
      // console.log("LLM调用结果:", llmResult);
      eventEmitter.emit('skill-log', `LLM调用完成: ${llmResult}`);
      
      callback(null, llmResult);
    } catch (error) {
      console.error('调用LLM时出错:', error);
      eventEmitter.emit('skill-log', `调用LLM出错: ${error}`);
      callback(error, 'LLM调用失败');
    }
  }

  async mcpService(scope: any, callback: any) {
    // 调用MCP服务处理逻辑
    eventEmitter.emit('skill-log', `调用MCP服务处理任务: ${scope.content.name}`);
    
    // 调用LLM分析任务，提取MCP服务URL、系统提示词、用户指令等
    try {
      let messages: OpenAI.ChatCompletionMessageParam[] = []
      messages.push({
          role: "system",
          content: "你是一个专业的任务分析助手，负责从技能内容中提取MCP服务调用信息。"
      });
      const analysisPrompt = `任务内容：${scope.content.name}
技能内容: ${scope.environment.variables.skillContent}
上下文信息: ${JSON.stringify(scope.environment.output)}

请根据任务内容，从技能内容和上下文信息中提取出MCP服务的URL和调用参数；如果需要加载额外的资源，请给出资源路径。

请严格按照以下JSON格式输出：
{
"mcpUrl": "MCP服务URL",
"mcpArgs": "调用数据（如果需要）",
"resourcePath": "资源路径（如果需要）"
}`;
      messages.push({
          role: "user",
          content: analysisPrompt
      });
      console.log("Analysis Prompt:", analysisPrompt);
      const analysisResponse = await chatLLM({messages, stream:false, model:skillRuntime.model, temperature: 0.7});
      console.log("Analysis Response:", analysisResponse);
      // console.log("解析后的分析结果:", analysisResponse.contextData);
      
      let analysisResult: {
        mcpUrl?: string;
        mcpArgs?: string;
        resourcePath?: string;
      } = {};
      try {
        // 尝试解析JSON，处理可能被```json和```包裹的情况
        let parsedResponse = analysisResponse;
        if (parsedResponse.startsWith('```json') && parsedResponse.endsWith('```')) {
          // 移除```json和```包裹
          parsedResponse = parsedResponse.substring(7, parsedResponse.length - 3).trim();
        }
        // 尝试解析JSON
        analysisResult = JSON.parse(parsedResponse);
        // console.log("解析后的分析结果:", analysisResult);
      } catch (parseError) {
        // 如果解析失败，尝试从文本中提取信息
        console.log("JSON解析失败，尝试从文本中提取信息:", parseError);
        // 这里可以添加更复杂的文本解析逻辑
        analysisResult = {
          mcpUrl: "",
          mcpArgs: "",
          resourcePath: ""
        };
      }
      
      // 如果有资源路径，加载资源
      let resourceContent = "";
      if (analysisResult['resourcePath']) {
        // 这里应该实现资源加载逻辑，目前先简化处理
        console.log("需要加载资源:", analysisResult['resourcePath']);
      }
      
      // 准备调用MCP服务的参数
      const mcpUrl = analysisResult['mcpUrl'] || "";
      
      // 构建消息数组
      let userPrompt = "";
      // 添加输入参数
      if (scope.environment.output) {
        userPrompt += `上下文信息: ${JSON.stringify(scope.environment.output)}\n`;
      }
      messages = [
        // {
        //   role: "system" as const,
        //   content: "你需要调用工具来获取信息或执行操作，不要对工具的参数做任何假设。输出的格式要美化。"
        // },
        {
          role: "user" as const,
          content: `${userPrompt}\n${scope.content.name}`
        },
      ];
      
      const mcpResult = "MCP服务调用结果示例";
      // 调用MCP服务
      // const mcpResult = await chat(
      //   messages,
      //   {
      //     model: this.model,
      //     systemPrompt: "你需要调用工具来获取信息或执行操作，不要对工具的参数做任何假设。输出的格式要美化。",
      //     baseURL: this.openai.baseURL,
      //     apiKey: this.openai.apiKey
      //   },
      //   {
      //     url: mcpUrl
      //   }
      // );
      
      // 将结果存入scope.environment.output
      scope.environment.output[scope.environment.variables[scope.id].output] = mcpResult;
      
      // console.log("MCP服务调用结果:", mcpResult);
      eventEmitter.emit('skill-log', `MCP服务调用完成: ${mcpResult}`);
      
      callback(null, mcpResult);
    } catch (error) {
      console.error('调用MCP服务时出错:', error);
      eventEmitter.emit('skill-log', `调用MCP服务出错: ${error}`);
      callback(error, 'MCP服务调用失败');
    }
  }
}

// 导出单例实例
export const skillRuntime = new SkillRuntime();