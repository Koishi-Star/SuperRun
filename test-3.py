"""
《静夜思》
—— 李白

床前明月光，
疑是地上霜。
举头望明月，
低头思故乡。
"""
class Person:
    """一个简单的Person类示例"""
    
    def __init__(self, name, age, gender, profession):
        self.name = name
        self.age = age
        self.gender = gender
        self.profession = profession
    
    def greet(self):
        """打招呼方法"""
        return f"你好，我叫{self.name}，今年{self.age}岁，性别{self.gender}，职业是{self.profession}。"
    
    def have_birthday(self):
        """过生日，年龄加1"""
        self.age += 1
        return f"{self.name}过生日了，现在{self.age}岁！"
    
    def change_profession(self, new_profession):
        """更换职业"""
        old_profession = self.profession
        self.profession = new_profession
        return f"{self.name}从{old_profession}转行成为{self.profession}"


# 使用示例
if __name__ == "__main__":
    # 创建Person实例
    person1 = Person("小明", 25, "男", "软件工程师")
    person2 = Person("小红", 22, "女", "设计师")
    
    # 调用方法
    print(person1.greet())
    print(person2.greet())
    
    # 过生日
    print(person1.have_birthday())
    
    # 查看更新后的信息
    print(f"{person1.name}的最新年龄: {person1.age}")
    
    # 更换职业
    print(person1.change_profession("产品经理"))
    print(person1.greet())
