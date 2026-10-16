// Project copy is adapted from the resume. Award names, dates, and team lists follow the certificate images.
// Where the resume and a certificate disagree, the certificate wins. Do not add duties that are not written down.

export const profile = {
  name: '卢涵煜',
  handle: 'Nekosan235',
  tagline: '自动化本科｜PLC·视觉·系统联调｜南京',
  school: '南京晓庄学院 · 自动化本科 · 2027届',
};

const noPhoto = {
  src: '/assets/portfolio/no-photo.svg',
  alt: '暂无实物照片',
  caption: '这项没有奖状，也还没有现场照片。',
};

export const honors = [
  {
    id: 'siemens-2025-east-first',
    title: '西门子杯华东初赛一等奖',
    src: '/assets/portfolio/siemens-cup-2025-east-first.jpg',
    alt: '2025年西门子杯流程行业自动化方向初赛一等奖奖状，团队成员中有卢涵煜',
    caption: '第十九届西门子杯中国智能制造挑战赛，流程行业自动化方向，华东赛区初赛一等奖（2025年7月）。团队：王梓名、张晨阳、卢涵煜、吴浩然、唐睿、张子扬。指导教师陈为霞。',
    projectPath: '/work/forest-drone',
  },
  {
    id: 'siemens-2024-east-third',
    title: '西门子杯华东三等奖',
    src: '/assets/portfolio/siemens-cup-2024-east-third.jpg',
    alt: '2024年西门子杯流程行业自动化方向三等奖奖状，团队成员中有卢涵煜',
    caption: '第十八届西门子杯中国智能制造挑战赛，流程行业自动化方向，华东赛区三等奖（2024年8月）。团队：卢涵煜、王梓名、唐睿、张晨阳、吴浩然。指导教师陈为霞。',
    projectPath: '/work/hydrogen',
  },
  {
    id: 'inovance-2026-regional-gold',
    title: '汇川杯华东区域赛金牌',
    src: '/assets/portfolio/inovance-cup-2026-regional-gold.jpg',
    alt: '2026年汇川杯智能制造应用华东区域赛金牌奖状，团队成员中有卢涵煜',
    caption: '2026年第三届汇川杯智能制造应用赛，华东区域赛金牌（2026年7月）。团队：卢涵煜、王梓名、张晨阳。指导教师陈为霞。',
    projectPath: '/work/inovance-vision',
  },
  {
    id: 'inovance-2026-national-bronze',
    title: '汇川杯全国总决赛铜牌',
    src: '/assets/portfolio/inovance-cup-2026-national-bronze.jpg',
    alt: '2026年汇川杯智能制造应用全国总决赛铜牌奖状，团队成员中有卢涵煜',
    caption: '2026年第三届汇川杯智能制造应用赛，全国总决赛铜牌（2026年8月）。团队：卢涵煜、王梓名、张晨阳。指导教师陈为霞。',
    projectPath: '/work/inovance-vision',
  },
  {
    id: 'siemens-2026-engineering-third',
    title: '西门子杯工程思维与创新实践三等奖',
    src: '/assets/portfolio/siemens-cup-2026-engineering-third.jpg',
    alt: '2026年西门子杯工程思维与创新实践赛三等奖奖状，团队成员中有卢涵煜',
    caption: '第十九届西门子杯中国智能制造挑战赛，工程思维与创新实践赛三等奖（2026年7月）。团队：王梓名、卢涵煜、张晨阳。指导教师陈为霞。这是单独赛项，不计入森林消防或风光制氢。',
    projectPath: null,
  },
  {
    id: 'ican-2025-jiangzhe-third',
    title: 'iCAN 江浙赛区三等奖',
    src: '/assets/portfolio/ican-2025-jiangzhe-third.jpg',
    alt: '2025年iCAN大学生创新创业大赛江浙赛区三等奖奖状，团队成员中有卢涵煜',
    caption: '第十二届 ICAN 大学生创新创业大赛江浙赛区三等奖（2025年9月）。项目：基于 AI 的非接触式电梯控制系统。团队：卢涵煜、王梓名、张晨阳、吴浩然。指导教师陈为霞。',
    projectPath: '/work/ican-elevator',
  },
  {
    id: 'advantech-aiot-2025-excellence',
    title: '研华 AIoT 优秀奖',
    src: '/assets/portfolio/advantech-aiot-2025-excellence.jpg',
    alt: '2025年研华AIoT创新赛优秀奖奖状，团队成员中有卢涵煜',
    caption: '2025年第三届研华 AIoT 创新赛优秀奖（2025年8月）。项目：基于 AIoT 的电梯智能监测系统。团队：王梓名、卢涵煜、张晨阳。指导教师陈为霞。',
    projectPath: '/work/advantech-elevator',
  },
];

export function honorById(id) {
  return honors.find((item) => item.id === id) || null;
}

export const featuredProjects = [
  {
    id: 'forest-drone',
    path: '/work/forest-drone',
    title: '无人机森林消防系统',
    kicker: '01 · 西门子杯',
    badge: '华东初赛一等奖',
    tone: 'award',
    summary: 'S7-1200 · TIA 博途 · CAD · 阿里云 MQTT · ROS 联调',
    period: '2024-01 至今',
    role: '项目经理',
    team: '王梓名、张晨阳、卢涵煜、吴浩然、唐睿、张子扬',
    advisor: '陈为霞',
    background: '针对森林消防应急作业的时效问题，做一套能落地的无人机森林消防自动化作业系统，把结构、通信和机构动作收在同一套控制里。',
    duties: [
      '负责无人机机舱整体结构的 CAD 建模和布局。',
      '用 TIA 博途和西门子 S7-1200 编写机构动作控制逻辑。',
      '搭建阿里云与 MQTT 通信，用信捷物联网关做机舱和无人机的数据交互、设备联动。',
      '配合 ROS 做整机联调、排故和功能修正，处理通信不稳、机构动作偏差。',
    ],
    tech: [
      '西门子 S7-1200 与 TIA 博途：机构动作控制',
      '机舱结构 CAD 建模与布局',
      '阿里云 MQTT、信捷物联网关，配合 ROS 联调',
    ],
    results: [
      '设备按控制逻辑做启停和机构动作，现场处理过通信不稳和机构动作偏差。',
      '第十九届西门子杯中国智能制造挑战赛，流程行业自动化方向，华东赛区初赛一等奖（2025年7月）。',
    ],
    note: '奖状按队员署名。上面几条是简历里写的本人职责，不是把全队的工作算成一个人做的。',
    imageIds: ['siemens-2025-east-first'],
    modelSlot: 'forest-drone-cabin',
  },
  {
    id: 'hydrogen',
    path: '/work/hydrogen',
    title: '风光制氢自动化控制系统',
    kicker: '02 · 西门子杯',
    badge: '华东三等奖',
    tone: 'award',
    summary: '控制柜 · 电路 · 博途程序 · 整机调试',
    period: '2024-02 至 2024-09',
    role: '项目经理',
    team: '卢涵煜、王梓名、唐睿、张晨阳、吴浩然',
    advisor: '陈为霞',
    background: '围绕风光制氢的轻量化和能源自循环，搭一套自动化控制平台，完成设备集成、电路和程序，并做出制氢设备的自动化模拟运行。',
    duties: [
      '做系统平台架构和 CAD 布局，完成配套设备选型、安装和集成。',
      '独立完成控制柜装配、电路规划与设计。',
      '用博途编写风光制氢自动化控制程序。',
      '参与整机调试、功能测试和运行验证，排查电路、程序和设备适配问题。',
    ],
    tech: [
      '控制柜装配与电路设计',
      '博途风光制氢控制程序',
      'CAD 布局、设备集成与整机调试',
    ],
    results: [
      '完成控制平台的设备集成、控制柜和程序，并做出制氢设备的自动化模拟运行。',
      '第十八届西门子杯中国智能制造挑战赛，流程行业自动化方向，华东赛区三等奖（2024年8月）。',
    ],
    note: '奖状按队员署名。上面几条是简历里写的本人职责，不是把全队的工作算成一个人做的。',
    imageIds: ['siemens-2024-east-third'],
    modelSlot: 'hydrogen-skid',
  },
  {
    id: 'servo-screw',
    path: '/work/servo-screw',
    title: 'S7-1200 + V90 伺服丝杆传动',
    kicker: '03 · 运动控制',
    badge: '课程项目',
    tone: 'plain',
    summary: 'PLC 程序 · V90 参数 · 速度与位置联调',
    period: '2026-03 至 2026-05',
    role: '设计师',
    background: '以西门子 S7-1200 为控制核心，用 SINAMICS V90 驱动伺服电机，通过丝杆把旋转变成直线运动，并做定位。',
    duties: [
      '编写 PLC 程序，配置伺服驱动器参数。',
      '搭建伺服电机和丝杆传动机构。',
      '调试速度、位置控制，并完成系统联调。',
    ],
    tech: [
      'S7-1200 PLC 程序',
      'SINAMICS V90 伺服参数',
      '丝杆传动的速度、位置控制与联调',
    ],
    results: [
      '伺服电机能带动丝杆做定位和调速，系统完成联调。',
      '没有竞赛奖项。这是硬技能课程项目。',
    ],
    images: [noPhoto],
    modelSlot: 'servo-screw',
  },
  {
    id: 'inovance-vision',
    path: '/work/inovance-vision',
    title: '汇川杯工业视觉',
    kicker: '04 · 汇川杯',
    badge: '全国铜牌 · 区域金牌',
    tone: 'award',
    summary: '工业视觉相关 · 对接智能制造',
    period: '2026-07 至 2026-08',
    role: '队员',
    team: '卢涵煜、王梓名、张晨阳',
    advisor: '陈为霞',
    background: '2026 年第三届汇川杯「智能制造应用」赛项作品，方向是工业视觉，用来对接智能制造场景。',
    duties: [
      '与王梓名、张晨阳组队参赛，指导教师陈为霞。',
      '简历没有单列本人在这项里的具体分工，这里不补写编程、算法或器件工作。',
    ],
    tech: [
      '赛项：智能制造应用',
      '方向：工业视觉相关',
      '层级：华东区域赛、全国总决赛',
    ],
    results: [
      '2026年7月，华东区域赛金牌。',
      '2026年8月，全国总决赛铜牌。',
    ],
    imageIds: ['inovance-2026-regional-gold', 'inovance-2026-national-bronze'],
  },
];

export const otherProjects = [
  {
    id: 'mcu-music',
    path: '/work/mcu-music',
    title: '51单片机音乐播放器',
    kicker: '其他 · 单片机',
    badge: '课程练习',
    tone: 'plain',
    summary: 'LCD12864 歌词 + 蜂鸣器同步播放',
    period: '2026-01 至今',
    role: '设计师',
    background: '基于 51 单片机做音乐播放，LCD12864 实时显示歌词，蜂鸣器按同一套节拍出声。',
    duties: [
      '完成元器件选型和硬件电路搭建。',
      '编写单片机程序，用定时器控制节拍，并刷新液晶显示。',
      '负责软硬件联调和功能调试。',
    ],
    tech: [
      '51 单片机定时器节拍',
      'LCD12864 歌词刷新',
      '蜂鸣器与液晶同步',
    ],
    results: [
      '乐曲播放和歌词显示能同步。',
      '没有竞赛奖项。',
    ],
    images: [noPhoto],
  },
  {
    id: 'advantech-elevator',
    path: '/work/advantech-elevator',
    title: '基于 AIoT 的电梯智能监测系统',
    kicker: '其他 · 研华',
    badge: '研华优秀奖',
    tone: 'award',
    summary: '2025 年第三届研华 AIoT 创新赛',
    period: '2025-08',
    role: '队员',
    team: '王梓名、卢涵煜、张晨阳',
    advisor: '陈为霞',
    background: '2025 年第三届研华 AIoT 创新赛作品，题目是基于 AIoT 的电梯智能监测。',
    duties: [
      '证书署名为王梓名、卢涵煜、张晨阳，指导教师陈为霞。',
      '简历未写本人分工，不补充监测点、模型或部署工作。',
    ],
    techHeading: '关键信息',
    tech: [
      '赛项：研华 AIoT 创新赛',
      '题目：电梯智能监测',
      '成绩：优秀奖（2025年8月）',
    ],
    results: [
      '2025年第三届研华 AIoT 创新赛优秀奖。',
    ],
    imageIds: ['advantech-aiot-2025-excellence'],
  },
  {
    id: 'ican-elevator',
    path: '/work/ican-elevator',
    title: '基于 AI 的非接触式电梯控制系统',
    kicker: '其他 · iCAN',
    badge: '江浙三等奖',
    tone: 'award',
    summary: '2025 年 ICAN 江浙赛区',
    period: '2025-09',
    role: '队员',
    team: '卢涵煜、王梓名、张晨阳、吴浩然',
    advisor: '陈为霞',
    background: '2025 年第十二届 ICAN 大学生创新创业大赛作品，题目是基于 AI 的非接触式电梯控制。',
    duties: [
      '证书署名为卢涵煜、王梓名、张晨阳、吴浩然，指导教师陈为霞。',
      '简历未写本人分工，不补充算法、传感器或控制程序。',
    ],
    techHeading: '关键信息',
    tech: [
      '赛项：ICAN 大学生创新创业大赛',
      '题目：非接触式电梯控制',
      '成绩：江浙赛区三等奖（2025年9月）',
    ],
    results: [
      '第十二届 ICAN 大学生创新创业大赛江浙赛区三等奖。',
    ],
    imageIds: ['ican-2025-jiangzhe-third'],
  },
];

export function projectById(id) {
  return [...featuredProjects, ...otherProjects].find((item) => item.id === id) || null;
}

export function projectFigures(project) {
  if (project.imageIds?.length) {
    return project.imageIds.map((id) => {
      const image = honorById(id);
      if (!image) throw new Error(`Unknown award image: ${id}`);
      return image;
    });
  }
  return project.images || [];
}

export function allProjects() {
  return [...featuredProjects, ...otherProjects];
}
