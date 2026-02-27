import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { logger } from './logger';

/**
 * 技能信息接口
 */
interface SkillInfo {
  name: string;
  description: string;
  path: string;
}

/**
 * 技能管理类
 */
class SkillManager {
  private skillsDirectory: string;
  private skillsCache: SkillInfo[] | null = null;
  private cacheTimestamp: number | null = null;
  private readonly CACHE_DURATION = 5000; // 5秒缓存

  constructor() {
    let skillsPath = path.join(process.cwd(), '.skills')
      if (process.env.NODE_ENV === 'development') {
        skillsPath = path.join(process.cwd(), '.skills')
      }
    this.skillsDirectory = skillsPath
  }

  /**
   * 列出所有可用的技能
   * @returns 可用技能列表
   */
  async listSkills(): Promise<SkillInfo[]> {
    // 检查缓存
    const now = Date.now();
    if (this.skillsCache && this.cacheTimestamp && (now - this.cacheTimestamp < this.CACHE_DURATION)) {
      return this.skillsCache;
    }

    try {
      // 检查技能目录是否存在
      if (!fs.existsSync(this.skillsDirectory)) {
        logger.info(`技能目录不存在: ${this.skillsDirectory}`);
        this.skillsCache = [];
        this.cacheTimestamp = now;
        return [];
      }

      // 读取所有子目录
      const skillDirs = fs.readdirSync(this.skillsDirectory)
        .filter(item => fs.statSync(path.join(this.skillsDirectory, item)).isDirectory());

      const skills: SkillInfo[] = [];

      for (const skillDir of skillDirs) {
        const skillPath = path.join(this.skillsDirectory, skillDir);
        const metadata = await this.readSkillMetadata(skillPath);
        
        if (metadata) {
          skills.push({
            name: metadata.name,
            description: metadata.description,
            path: skillPath
          });
        }
      }

      logger.info(`找到 ${skills.length} 个技能`);
      this.skillsCache = skills;
      this.cacheTimestamp = now;
      return skills;
    } catch (error) {
      logger.error('列出技能时出错:', error);
      this.skillsCache = [];
      this.cacheTimestamp = now;
      return [];
    }
  }

  /**
   * 清除技能缓存
   */
  clearCache(): void {
    this.skillsCache = null;
    this.cacheTimestamp = null;
  }

  /**
   * 读取技能元数据
   * @param skillPath 技能目录路径
   * @returns 技能元数据
   */
  private async readSkillMetadata(skillPath: string): Promise<Pick<SkillInfo, 'name' | 'description'> | null> {
    try {
      const skillFilePath = path.join(skillPath, 'SKILL.md');
      
      if (!fs.existsSync(skillFilePath)) {
        logger.warn(`技能 ${skillPath} 缺少 SKILL.md 文件`);
        return null;
      }

      const skillContent = fs.readFileSync(skillFilePath, 'utf-8');
      const metadata = this.parseMetadata(skillContent);
      
      if (!metadata.name) {
        logger.warn(`技能 ${skillPath} 缺少名称`);
        return null;
      }

      if (!metadata.description) {
        logger.warn(`技能 ${skillPath} 缺少描述`);
        return null;
      }

      return {
        name: metadata.name,
        description: metadata.description,
      };
    } catch (error) {
      logger.error(`读取技能元数据失败 ${skillPath}:`, error);
      return null;
    }
  }

  /**
   * 解析 SKILL.md 中的元数据
   * @param content SKILL.md 内容
   * @returns 解析后的元数据
   */
  private parseMetadata(content: string): Partial<Pick<SkillInfo, 'name' | 'description'>> {
    const metadata: Partial<Pick<SkillInfo, 'name' | 'description'>> = {};
    
    // 解析 YAML 格式的元数据
    const yamlMatch = content.match(/---[\s\S]*?---/);
    if (yamlMatch) {
      const yamlContent = yamlMatch[0].replace(/^---\s*$/, '').replace(/---\s*$/, '');
      const lines = yamlContent.split('\n');
      for (const line of lines) {
        const [key, value] = line.split(':').map(s => s.trim());
        if (key && value) {
          // 使用类型断言确保 key 是有效的属性名
          const validKey = key as keyof Pick<SkillInfo, 'name' | 'description'>;
          metadata[validKey] = value.replace(/^['"](.*)['"]$/, '$1'); // 去除引号
        }
      }
    }

    // // 如果没有 YAML 格式元数据，尝试解析 Markdown 标题
    // if (!metadata.name) {
    //   const titleMatch = content.match(/^# (.+)/);
    //   if (titleMatch) {
    //     metadata.name = titleMatch[1].trim() as any;
    //   }
    // }

    return metadata;
  }

  /**
   * 读取技能正文内容
   * @param skillPath 技能目录路径
   * @returns 技能内容
   */
  readSkillContent(skillPath: string): string {
    try {
      const mdFilePath = path.join(skillPath, 'SKILL.md');
      const content = fs.readFileSync(mdFilePath, 'utf-8');
      
      // 移除元数据部分，只保留正文
      const contentWithoutMetadata = content.replace(/---[\s\S]*?---/, '').trim();
      return contentWithoutMetadata;
    } catch (error) {
      logger.error(`读取技能内容失败 ${skillPath}:`, error);
      return '';
    }
  }

  /**
   * 根据技能名称选择技能
   * @param skillName 技能名称
   * @returns 技能信息
   */
  async selectSkill(skillName: string): Promise<SkillInfo | null> {
    const skills = await this.listSkills();
    return skills.find(skill => skill.name === skillName) || null;
  }

  /**
   * 加载技能的完整指令
   * @param skill 技能信息
   * @returns 完整指令内容
   */
  async loadFullInstructions(skill: SkillInfo): Promise<string> {
    try {
      // 读取完整指令文件
      const instructionsPath = path.join(skill.path, 'INSTRUCTIONS.md');
      if (fs.existsSync(instructionsPath)) {
        const instructions = fs.readFileSync(instructionsPath, 'utf-8');
        return instructions;
      }

      // 如果没有单独的指令文件，则读取技能内容
      return this.readSkillContent(skill.path);
    } catch (error) {
      logger.error(`加载技能完整指令失败 ${skill.name}:`, error);
      return this.readSkillContent(skill.path);
    }
  }


  /**
   * 启动时初始化技能系统
   */
  async initialize(): Promise<void> {
    try {
      logger.info('正在初始化技能系统...');
      
      // 加载技能元数据
      const skills = await this.listSkills();
      
      logger.info(`技能系统初始化完成，共加载 ${skills.length} 个技能`);
      
      // 可以在这里添加更多初始化逻辑
      // 比如：验证技能文件、检查依赖等
    } catch (error) {
      logger.error('技能系统初始化失败:', error);
      throw error;
    }
  }

  /**
   * 添加新技能
   * @param skillName 技能名称
   * @param metadata 技能元数据
   * @param content 技能内容
   */
  async addSkill(skillName: string, metadata: Pick<SkillInfo, 'name' | 'description'>, content: string): Promise<void> {
    try {
      const skillPath = path.join(this.skillsDirectory, skillName);
      
      // 创建技能目录
      if (!fs.existsSync(skillPath)) {
        fs.mkdirSync(skillPath, { recursive: true });
      }
      
      // 写入 SKILL.md 文件
      const mdContent = `---
name: ${metadata.name}
description: ${metadata.description}
---
${content}`;
      
      const mdFilePath = path.join(skillPath, 'SKILL.md');
      fs.writeFileSync(mdFilePath, mdContent, 'utf-8');
      
      // 清除缓存
      this.clearCache();
      
      logger.info(`技能 "${skillName}" 添加成功`);
    } catch (error) {
      logger.error(`添加技能失败 "${skillName}":`, error);
      throw error;
    }
  }
}

// 导出单例实例
export const skillManager = new SkillManager();

// 导出接口
export type { SkillInfo };
